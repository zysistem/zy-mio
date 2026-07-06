/**
 * HDFilmCehennemi Stremio Addon - Catalog Module
 * 
 * Handles catalog/category scraping for Stremio browse UI.
 * Scrapes homepage sections for latest movies and series.
 * Uses slug-based IDs for instant loading (no per-item HTTP requests).
 * 
 * @module catalog
 */

const { fetch } = require('undici');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');

const log = createLogger('Catalog');

const BASE_URL = 'https://www.hdfilmcehennemi.nl';

const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

/**
 * Scrape items from a category page (single HTTP request, instant results)
 * @param {string} url - Page URL to scrape
 * @param {'movie'|'series'} type - Content type filter
 * @param {number} [year] - Optional year filter
 * @param {number} [limit] - Max items to return
 * @returns {Promise<Array<{id: string, type: string, name: string, poster: string}>>}
 */
async function scrapeCatalogPage(url, type, year = null, limit = 50) {
    try {
        log.info(`Scraping catalog: ${url} (type=${type}, year=${year || 'all'})`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, {
            headers: defaultHeaders,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // Extract year from URL if in a year-based category page
        const urlYearMatch = url.match(/\/yil\/(\d{4})/);
        const urlYear = urlYearMatch ? parseInt(urlYearMatch[1]) : null;

        const items = [];
        const seen = new Set();

        // Process slider and mini-poster items
        $('.mini-poster, .slider-slide a.poster-slider').each((i, el) => {
            if (items.length >= limit) return false;

            const href = $(el).attr('href') || $(el).find('a').attr('href');
            if (!href || !href.includes('hdfilmcehennemi')) return;

            // Skip non-content links
            if (href.match(/category|yabancidizi|film-izle|film-robotu|iletisim|film-istek|serifilmler|apk|windows|cdn-cgi|fragman/)) return;

            // Type detection from URL
            const isSeries = href.includes('/dizi/');
            if (type === 'movie' && isSeries) return;
            if (type === 'series' && !isSeries) return;

            // Dedup by href
            if (seen.has(href)) return;
            seen.add(href);

            const title = $(el).find('img').attr('alt') || '';
            const poster = $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || '';

            // Year detection from surrounding text
            const parentText = $(el).parent().text();
            const yearMatches = parentText.match(/\b((?:19|20)\d{2})\b/g);
            const itemYear = yearMatches ? parseInt(yearMatches[0]) : null;

            // Year filter
            if (year && itemYear && itemYear !== year) return;

            // Clean title - remove "izle" suffix
            const cleanTitle = title.replace(/\s*izle\s*$/i, '').trim();
            if (!cleanTitle) return;

            // Build slug-based ID from URL
            const slug = href.replace(BASE_URL, '').replace(/^\//, '').replace(/\/$/, '');

            items.push({
                id: slug,
                type: isSeries ? 'series' : 'movie',
                name: cleanTitle,
                poster: poster.startsWith('http') ? poster : (poster ? BASE_URL + poster : ''),
            });
        });

        log.info(`Catalog ready: ${items.length} items for ${type}${year ? ` (${year})` : ''}`);
        return items;

    } catch (error) {
        log.error(`Failed to scrape catalog: ${error.message}`);
        return [];
    }
}

// Cache for catalog results
const catalogCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get catalog with caching
 */
async function getCachedCatalog(cacheKey, fetcher) {
    const cached = catalogCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        log.info(`Using cached catalog: ${cacheKey}`);
        return cached.items;
    }

    const items = await fetcher();
    catalogCache.set(cacheKey, { items, timestamp: Date.now() });
    return items;
}

/**
 * Son Eklenen Filmler
 */
async function getLatestMovies() {
    return getCachedCatalog('latest_movies', async () => {
        return scrapeCatalogPage(BASE_URL + '/', 'movie', null, 40);
    });
}

/**
 * Son Eklenen Diziler
 */
async function getLatestSeries() {
    return getCachedCatalog('latest_series', async () => {
        return scrapeCatalogPage(BASE_URL + '/', 'series', null, 40);
    });
}

/**
 * Yıla göre filmler
 */
async function getMoviesByYear(year) {
    return getCachedCatalog(`movies_${year}`, async () => {
        // Homepage has all movies - filter by year from page content
        return scrapeCatalogPage(BASE_URL + '/', 'movie', year, 60);
    });
}

module.exports = {
    getLatestMovies,
    getLatestSeries,
    getMoviesByYear,
};
