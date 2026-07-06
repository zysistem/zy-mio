/**
 * HDFilmCehennemi Stremio Addon - Catalog Module
 * 
 * Handles catalog/category scraping for Stremio browse UI.
 * Scrapes homepage sections for latest movies and series.
 * 
 * @module catalog
 */

const { fetch } = require('undici');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');
const { getWorkingProxy, markProxyBad, createProxyAgent, isProxyEnabled, isProxyAlways } = require('./proxy');

const log = createLogger('Catalog');

const BASE_URL = 'https://www.hdfilmcehennemi.nl';

const CONFIG = {
    timeout: 15000,
    maxRetries: 2,
    retryDelay: 1000,
};

const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isHdfilmcehennemiUrl(url) {
    return url.includes('hdfilmcehennemi.nl') || url.includes('hdfilmcehennemi.mobi');
}

/**
 * Simple HTTP GET with retry and proxy fallback for catalog fetching
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} Response text
 */
async function httpGet(url) {
    let lastError = null;
    let useProxy = isProxyAlways() && isHdfilmcehennemiUrl(url);

    // Direct attempt
    if (!useProxy) {
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

                const response = await fetch(url, {
                    headers: defaultHeaders,
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.status === 403 && isHdfilmcehennemiUrl(url)) {
                    useProxy = true;
                    break;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const text = await response.text();
                if (text.includes('cf-browser-verification') || text.includes('Just a moment')) {
                    useProxy = true;
                    break;
                }

                return text;
            } catch (error) {
                lastError = error;
                if (attempt < CONFIG.maxRetries) {
                    await sleep(CONFIG.retryDelay * attempt);
                }
            }
        }
    }

    // Proxy fallback
    if (useProxy && isProxyEnabled() && isHdfilmcehennemiUrl(url)) {
        for (let proxyAttempt = 1; proxyAttempt <= 3; proxyAttempt++) {
            const proxy = await getWorkingProxy();
            if (!proxy) break;

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
                const dispatcher = createProxyAgent(proxy);

                const response = await fetch(url, {
                    headers: defaultHeaders,
                    signal: controller.signal,
                    dispatcher
                });
                clearTimeout(timeoutId);

                if (response.status === 403) {
                    markProxyBad(proxy);
                    continue;
                }

                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const text = await response.text();
                if (text.includes('cf-browser-verification') || text.includes('Just a moment')) {
                    markProxyBad(proxy);
                    continue;
                }

                return text;
            } catch (error) {
                lastError = error;
                markProxyBad(proxy);
            }
        }
    }

    throw lastError || new Error('All fetch attempts failed');
}

/**
 * Scrape items from a category page
 * @param {string} url - Page URL to scrape
 * @param {'movie'|'series'} type - Content type filter
 * @param {number} [year] - Optional year filter
 * @param {number} [limit] - Max items to return
 * @returns {Promise<Array<{id: string, type: string, name: string, poster: string, imdbId: string}>>}
 */
async function scrapeCatalogPage(url, type, year = null, limit = 50) {
    try {
        log.info(`Scraping catalog: ${url} (type=${type}, year=${year || 'all'})`);

        const html = await httpGet(url);
        const $ = cheerio.load(html);

        // Extract year from URL if in a year-based category page
        const urlYearMatch = url.match(/\/yil\/(\d{4})/);
        const urlYear = urlYearMatch ? parseInt(urlYearMatch[1]) : null;

        const items = [];
        const seen = new Set();

        // Process all mini-poster items
        $('.mini-poster, .slider-slide a').each((i, el) => {
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

            // Year detection from title or surrounding text
            const parentText = $(el).parent().text();
            const titleYearMatch = title.match(/\b(19|20)\d{2}\b/);
            const parentYearMatch = parentText.match(/\b((?:19|20)\d{2})\b/);
            const itemYear = titleYearMatch ? parseInt(titleYearMatch[1]) : (parentYearMatch ? parseInt(parentYearMatch[1]) : null);

            // Year filter
            if (year && itemYear && itemYear !== year) return;

            // Clean title - remove "izle" suffix
            const cleanTitle = title.replace(/\s*izle\s*$/i, '').trim();

            if (!cleanTitle) return;

            items.push({
                href,
                type: isSeries ? 'series' : 'movie',
                name: cleanTitle,
                poster: poster.startsWith('http') ? poster : (poster ? BASE_URL + poster : ''),
                year: itemYear || urlYear || null
            });
        });

        log.info(`Found ${items.length} raw items for ${type}${year ? ` (${year})` : ''}`);

        // Now fetch IMDb IDs for each item (in parallel batches)
        const itemsWithImdb = await fetchImdbIds(items);

        log.info(`Catalog ready: ${itemsWithImdb.length} items with IMDb IDs`);
        return itemsWithImdb;

    } catch (error) {
        log.error(`Failed to scrape catalog: ${error.message}`);
        return [];
    }
}

/**
 * Fetch IMDb IDs for catalog items by visiting their detail pages.
 * Finds a proxy once, then fetches all pages sequentially through it.
 * @param {Array} items - Raw catalog items
 * @returns {Promise<Array>} Items with IMDb IDs
 */
async function fetchImdbIds(items) {
    const results = [];

    for (const item of items) {
        try {
            const imdbId = await getImdbIdFromPageDirect(item.href);
            if (imdbId) {
                results.push({
                    id: imdbId,
                    type: item.type,
                    name: item.name,
                    poster: item.poster,
                });
                continue;
            }
        } catch (e) {
            // Direct failed, will try proxy below
        }

        // Store items that need proxy
        item._needsProxy = true;
    }

    // Collect items that still need IMDb ID (403'd items)
    const proxyItems = items.filter(i => i._needsProxy && !results.find(r => r.name === i.name));
    if (proxyItems.length === 0) return results;

    // Find one working proxy and use it for all remaining items
    if (!isProxyEnabled() || !isHdfilmcehennemiUrl(proxyItems[0].href)) {
        log.warn(`${proxyItems.length} items need proxy but proxy not enabled`);
        // For series: use slug-based ID as fallback
        for (const item of proxyItems) {
            const slug = item.href.replace(BASE_URL, '').replace(/^\//, '').replace(/\/$/, '');
            if (slug) {
                results.push({
                    id: `hdfc:${slug}`,
                    type: item.type,
                    name: item.name,
                    poster: item.poster,
                });
            }
        }
        return results;
    }

    log.info(`Finding proxy for ${proxyItems.length} items needing IMDb ID...`);
    const proxy = await getWorkingProxy();
    if (!proxy) {
        log.warn('No working proxy found for IMDb ID fetching');
        // For series: use slug-based ID as fallback
        for (const item of proxyItems) {
            const slug = item.href.replace(BASE_URL, '').replace(/^\//, '').replace(/\/$/, '');
            if (slug) {
                results.push({
                    id: `hdfc:${slug}`,
                    type: item.type,
                    name: item.name,
                    poster: item.poster,
                });
            }
        }
        return results;
    }

    let currentProxy = proxy;
    let currentDispatcher = createProxyAgent(proxy);

    for (const item of proxyItems) {
        try {
            const imdbId = await getImdbIdFromPageWithProxy(item.href, currentProxy, currentDispatcher);
            if (imdbId) {
                results.push({
                    id: imdbId,
                    type: item.type,
                    name: item.name,
                    poster: item.poster,
                });
            } else {
                log.debug(`No IMDb ID for: ${item.name}`);
            }
        } catch (e) {
            log.debug(`Failed to get IMDb ID for ${item.name}: ${e.message}`);
            markProxyBad(currentProxy);
            // Try to find a new proxy
            const newProxy = await getWorkingProxy();
            if (newProxy) {
                currentProxy = newProxy;
                currentDispatcher = createProxyAgent(newProxy);
            }
            // Use slug-based ID as final fallback
            const slug = item.href.replace(BASE_URL, '').replace(/^\//, '').replace(/\/$/, '');
            if (slug) {
                results.push({
                    id: `hdfc:${slug}`,
                    type: item.type,
                    name: item.name,
                    poster: item.poster,
                });
            }
        }
    }

    return results;
}

/**
 * Try to get IMDb ID with direct connection (no proxy)
 */
async function getImdbIdFromPageDirect(url) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

        const response = await fetch(url, {
            headers: defaultHeaders,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.status === 403) throw new Error('403');

        const html = await response.text();
        if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
            throw new Error('Cloudflare');
        }

        return extractImdbId(html);
    } catch (e) {
        return null;
    }
}

/**
 * Get IMDb ID using a specific proxy
 */
async function getImdbIdFromPageWithProxy(url, proxy, dispatcher) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

    const response = await fetch(url, {
        headers: defaultHeaders,
        signal: controller.signal,
        dispatcher
    });
    clearTimeout(timeoutId);

    if (response.status === 403) throw new Error('403');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
        throw new Error('Cloudflare');
    }

    return extractImdbId(html);
}

/**
 * Extract IMDb ID from HTML content
 * @param {string} html - Page HTML
 * @returns {string|null}
 */
function extractImdbId(html) {
    const $ = cheerio.load(html);

    // Method 1: Look for IMDb link in page
    let imdbId = null;
    $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.includes('imdb.com/title/tt')) {
            const match = href.match(/(tt\d{7,8})/);
            if (match) {
                imdbId = match[1];
                return false;
            }
        }
    });

    // Method 2: Search in JSON-LD
    if (!imdbId) {
        $('script[type="application/ld+json"]').each((i, el) => {
            const json = $(el).html();
            const match = json.match(/tt\d{7,8}/);
            if (match) {
                imdbId = match[0];
                return false;
            }
        });
    }

    // Method 3: Search in body text
    if (!imdbId) {
        const bodyText = $('body').text();
        const match = bodyText.match(/tt\d{7,8}/);
        if (match) {
            imdbId = match[0];
        }
    }

    return imdbId;
}

// Cache for catalog results
const catalogCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get catalog with caching
 * @param {string} cacheKey - Cache key
 * @param {Function} fetcher - Function to fetch catalog items
 * @returns {Promise<Array>}
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
 * Get "Son Eklenen Filmler" catalog
 * Scrapes homepage for latest movies
 * @returns {Promise<Array>}
 */
async function getLatestMovies() {
    return getCachedCatalog('latest_movies', async () => {
        return scrapeCatalogPage(BASE_URL + '/', 'movie', null, 40);
    });
}

/**
 * Get "Son Eklenen Diziler" catalog
 * Scrapes homepage for latest series
 * @returns {Promise<Array>}
 */
async function getLatestSeries() {
    return getCachedCatalog('latest_series', async () => {
        return scrapeCatalogPage(BASE_URL + '/', 'series', null, 40);
    });
}

/**
 * Get movies by year
 * Scrapes homepage and filters by year from title
 * @param {number} year - Year to filter
 * @returns {Promise<Array>}
 */
async function getMoviesByYear(year) {
    return getCachedCatalog(`movies_${year}`, async () => {
        // Try year-based category page first
        // If that fails (403), fall back to homepage scraping
        const yearUrls = {
            2025: BASE_URL + '/yil/2025-filmleri-izle-3/',
            2026: BASE_URL + '/yil/2026-filmleri/',
            2024: BASE_URL + '/yil/2024-2/',
            2023: BASE_URL + '/yil/2023-yapimi-filmler-4/',
        };

        const yearUrl = yearUrls[year];
        if (yearUrl) {
            try {
                const items = await scrapeCatalogPage(yearUrl, 'movie', year, 60);
                if (items.length > 0) return items;
            } catch (e) {
                log.warn(`Year page ${yearUrl} failed, falling back to homepage`);
            }
        }

        // Fallback: scrape homepage and filter by year
        return scrapeCatalogPage(BASE_URL + '/', 'movie', year, 60);
    });
}

module.exports = {
    getLatestMovies,
    getLatestSeries,
    getMoviesByYear,
};
