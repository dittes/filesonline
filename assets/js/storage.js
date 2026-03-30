// IndexedDB-based persistence for recipes and app settings

const DB_NAME = 'files-online-db';
const DB_VERSION = 1;
const STORE_RECIPES = 'recipes';
const STORE_SETTINGS = 'settings';

/** @type {boolean} */
export const isIndexedDBAvailable = (() => {
  try {
    return 'indexedDB' in window && window.indexedDB !== null;
  } catch {
    return false;
  }
})();

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

/** @type {IDBDatabase|null} */
let _db = null;

/**
 * Open (and if needed create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
export function initDB() {
  if (_db) return Promise.resolve(_db);

  if (!isIndexedDBAvailable) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_RECIPES)) {
        db.createObjectStore(STORE_RECIPES, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    request.onerror = (event) => {
      reject(new Error(`Failed to open IndexedDB: ${event.target.error?.message || 'unknown error'}`));
    };

    request.onblocked = () => {
      reject(new Error('IndexedDB open was blocked by another connection'));
    };
  });
}

/**
 * Run an IndexedDB transaction and return a Promise.
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {function(IDBObjectStore): IDBRequest|null} fn
 * @returns {Promise<any>}
 */
async function runTransaction(storeName, mode, fn) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);

    tx.onerror = () => reject(new Error(`Transaction error on ${storeName}: ${tx.error?.message}`));
    tx.onabort = () => reject(new Error(`Transaction aborted on ${storeName}`));

    let req;
    try {
      req = fn(store);
    } catch (err) {
      reject(err);
      return;
    }

    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`Request error: ${req.error?.message}`));
    } else {
      tx.oncomplete = () => resolve(undefined);
    }
  });
}

// ─── localStorage fallback helpers ───────────────────────────────────────────

const LS_PREFIX = 'files-online:';

function lsGetAll(namespace) {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${namespace}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function lsSetAll(namespace, data) {
  try {
    localStorage.setItem(`${LS_PREFIX}${namespace}`, JSON.stringify(data));
  } catch {
    // Storage quota exceeded or private mode — silently ignore
  }
}

function lsGetMap(namespace) {
  const arr = lsGetAll(namespace);
  const map = {};
  for (const item of arr) {
    if (item && item.id !== undefined) map[item.id] = item;
    else if (item && item.key !== undefined) map[item.key] = item;
  }
  return map;
}

// ─── Recipes ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Recipe
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {Object} config
 * @property {string} createdAt  ISO date string
 * @property {string} updatedAt  ISO date string
 */

/**
 * Upsert a recipe.
 * @param {Recipe} recipe
 * @returns {Promise<void>}
 */
export async function saveRecipe(recipe) {
  if (!recipe || !recipe.id) throw new Error('Recipe must have an id');

  if (isIndexedDBAvailable) {
    try {
      await runTransaction(STORE_RECIPES, 'readwrite', store => store.put(recipe));
      return;
    } catch (err) {
      console.warn('IndexedDB saveRecipe failed, falling back to localStorage:', err);
    }
  }

  // localStorage fallback
  const map = lsGetMap('recipes');
  map[recipe.id] = recipe;
  lsSetAll('recipes', Object.values(map));
}

/**
 * Retrieve all recipes.
 * @returns {Promise<Recipe[]>}
 */
export async function getRecipes() {
  if (isIndexedDBAvailable) {
    try {
      const results = await runTransaction(STORE_RECIPES, 'readonly', store => store.getAll());
      return Array.isArray(results) ? results : [];
    } catch (err) {
      console.warn('IndexedDB getRecipes failed, falling back to localStorage:', err);
    }
  }

  return lsGetAll('recipes');
}

/**
 * Delete a recipe by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteRecipe(id) {
  if (isIndexedDBAvailable) {
    try {
      await runTransaction(STORE_RECIPES, 'readwrite', store => store.delete(id));
      return;
    } catch (err) {
      console.warn('IndexedDB deleteRecipe failed, falling back to localStorage:', err);
    }
  }

  // localStorage fallback
  const arr = lsGetAll('recipes').filter(r => r.id !== id);
  lsSetAll('recipes', arr);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * Read a setting value by key.
 * @param {string} key
 * @returns {Promise<any>}
 */
export async function getSetting(key) {
  if (isIndexedDBAvailable) {
    try {
      const record = await runTransaction(STORE_SETTINGS, 'readonly', store => store.get(key));
      return record ? record.value : undefined;
    } catch (err) {
      console.warn('IndexedDB getSetting failed, falling back to localStorage:', err);
    }
  }

  // localStorage fallback
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}setting:${key}`);
    return raw !== null ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a setting value.
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
export async function setSetting(key, value) {
  const record = { key, value };

  if (isIndexedDBAvailable) {
    try {
      await runTransaction(STORE_SETTINGS, 'readwrite', store => store.put(record));
      return;
    } catch (err) {
      console.warn('IndexedDB setSetting failed, falling back to localStorage:', err);
    }
  }

  // localStorage fallback
  try {
    localStorage.setItem(`${LS_PREFIX}setting:${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// ─── Reset ────────────────────────────────────────────────────────────────────

/**
 * Clear all data in both object stores (and localStorage fallback).
 * @returns {Promise<void>}
 */
export async function clearAll() {
  if (isIndexedDBAvailable) {
    try {
      const db = await initDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_RECIPES, STORE_SETTINGS], 'readwrite');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.objectStore(STORE_RECIPES).clear();
        tx.objectStore(STORE_SETTINGS).clear();
      });
    } catch (err) {
      console.warn('IndexedDB clearAll failed:', err);
    }
  }

  // Also clear localStorage fallback keys
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}
