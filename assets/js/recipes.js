// Managed saved operation presets stored in IndexedDB

import { generateId, formatDate, escapeHtml } from './utils.js';
import { state, on, emit, setActiveModule } from './state.js';
import { $, $$, showToast, showConfirm } from './ui.js';

// ─── Storage helpers ──────────────────────────────────────────────────────────

const DB_NAME    = 'filesOnlineDB';
const DB_VERSION = 1;
const STORE_NAME = 'recipes';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(new Error('Could not open IndexedDB.'));
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(new Error('Failed to read recipes.'));
  });
}

async function dbPut(recipe) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.put(recipe);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(new Error('Failed to save recipe.'));
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(new Error('Failed to delete recipe.'));
  });
}

// ─── Starter recipes (not stored in DB) ──────────────────────────────────────

const STARTER_RECIPES = [
  {
    id: 'starter-rename-numbering',
    name: 'Rename: Add Numbering Prefix',
    description: 'Prepends a zero-padded number (001_, 002_...) to every file.',
    type: 'rename',
    config: {
      rules: [{ type: 'numbering', start: 1, step: 1, padding: 3, position: 'prefix', separator: '_' }],
      preserveExt: true,
    },
    isStarter: true,
  },
  {
    id: 'starter-archive-bundle',
    name: 'Archive: Bundle to ZIP',
    description: 'Packages all loaded files into a single ZIP archive.',
    type: 'archive',
    config: { action: 'create', zipName: 'bundle.zip' },
    isStarter: true,
  },
  {
    id: 'starter-export-csv',
    name: 'Export: Full Metadata CSV',
    description: 'Exports a CSV of all file metadata: name, size, type, modified date.',
    type: 'metadata-export',
    config: { fields: ['name', 'size', 'type', 'category', 'modified', 'path'], filename: 'file-metadata.csv' },
    isStarter: true,
  },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load recipes from IndexedDB into state.recipes.
 * @returns {Promise<void>}
 */
export async function loadRecipes() {
  try {
    const recipes = await dbGetAll();
    state.recipes = recipes.sort((a, b) => b.createdAt - a.createdAt);
    emit('recipes:loaded', state.recipes);
  } catch (err) {
    console.error('loadRecipes:', err);
    state.recipes = [];
  }
}

/**
 * Save a recipe to IndexedDB and refresh state.
 * @param {{ name: string, type: string, description?: string, config?: object }} recipe
 * @returns {Promise<object>}
 */
export async function saveCurrentRecipe(recipe) {
  const now = Date.now();
  const full = {
    id:          recipe.id || generateId(),
    name:        recipe.name,
    description: recipe.description || '',
    type:        recipe.type,
    config:      recipe.config || {},
    createdAt:   recipe.createdAt || now,
    updatedAt:   now,
  };
  await dbPut(full);
  await loadRecipes();
  return full;
}

/**
 * Delete a recipe by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteRecipe(id) {
  await dbDelete(id);
  await loadRecipes();
}

/**
 * Duplicate a recipe with a new ID and "(Copy) " prefix on name.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function duplicateRecipe(id) {
  await loadRecipes();
  const src = state.recipes.find(r => r.id === id);
  if (!src) throw new Error(`Recipe ${id} not found.`);
  const copy = {
    ...src,
    id:        generateId(),
    name:      `(Copy) ${src.name}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await dbPut(copy);
  await loadRecipes();
  return copy;
}

/**
 * Apply a recipe by dispatching to the correct module.
 * Emits 'recipe:apply' on the bus so other modules can respond.
 * @param {object} recipe
 */
export function applyRecipe(recipe) {
  emit('recipe:apply', recipe);
  // Take the user to the module the recipe configures
  const moduleByType = {
    'rename': 'rename',
    'archive': 'archive',
    'metadata-export': 'metadata',
  };
  const target = moduleByType[recipe.type];
  if (target) setActiveModule(target);
}

// ─── Module UI ────────────────────────────────────────────────────────────────

/**
 * Render the recipes module UI into containerEl.
 * @param {HTMLElement} containerEl
 */
export function initRecipesModule(containerEl) {
  // ── Shell ──────────────────────────────────────────────────────────────────
  containerEl.innerHTML = `
    <div class="recipes-module">
      <div class="recipes-header">
        <div>
          <h2 class="recipes-heading">Saved Recipes</h2>
          <p class="recipes-subtitle">Save and reuse operation presets for rename, archive, and export tasks.</p>
        </div>
        <button class="btn btn-primary" id="recipes-create-btn">+ Create Recipe</button>
      </div>

      <section class="recipes-section">
        <h3 class="recipes-section-title">Starter Templates</h3>
        <div class="recipes-grid" id="recipes-starters-grid"></div>
      </section>

      <section class="recipes-section">
        <h3 class="recipes-section-title">My Recipes</h3>
        <div class="recipes-grid" id="recipes-user-grid">
          <div class="recipes-empty" id="recipes-empty-state">
            <p>No recipes saved yet.</p>
            <button class="btn btn-secondary btn-sm" id="recipes-empty-create-btn">Create your first recipe</button>
          </div>
        </div>
      </section>

      <!-- Create / Edit modal -->
      <div class="modal-backdrop" id="recipes-modal-backdrop" hidden>
        <div class="modal recipes-modal" role="dialog" aria-modal="true" aria-labelledby="recipes-modal-title">
          <div class="modal-header">
            <h3 id="recipes-modal-title">Create Recipe</h3>
            <button class="modal-close btn btn-ghost" id="recipes-modal-close" aria-label="Close">✕</button>
          </div>
          <div class="modal-body">
            <label class="form-label">Name <span class="required">*</span>
              <input type="text" id="recipe-name-input" class="form-input" placeholder="My rename rule..." maxlength="80">
            </label>
            <label class="form-label">Type
              <select id="recipe-type-select" class="form-select">
                <option value="rename">Rename</option>
                <option value="archive">Archive</option>
                <option value="metadata-export">Metadata Export</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label class="form-label">Description
              <textarea id="recipe-desc-textarea" class="form-textarea" rows="2" placeholder="Optional description..." maxlength="300"></textarea>
            </label>
            <label class="form-label">
              Config (JSON — optional)
              <p class="form-hint">Advanced: paste a JSON config object. Leave blank to save an empty config.</p>
              <textarea id="recipe-config-textarea" class="form-textarea form-textarea--mono" rows="4" placeholder='{ "rules": [] }'></textarea>
            </label>
            <p class="form-error" id="recipe-form-error" hidden></p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="recipes-modal-cancel">Cancel</button>
            <button class="btn btn-primary" id="recipes-modal-save">Save Recipe</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // ── Element refs ──────────────────────────────────────────────────────────
  const startersGrid    = containerEl.querySelector('#recipes-starters-grid');
  const userGrid        = containerEl.querySelector('#recipes-user-grid');
  const emptyState      = containerEl.querySelector('#recipes-empty-state');
  const createBtn       = containerEl.querySelector('#recipes-create-btn');
  const emptyCreateBtn  = containerEl.querySelector('#recipes-empty-create-btn');
  const modalBackdrop   = containerEl.querySelector('#recipes-modal-backdrop');
  const modalClose      = containerEl.querySelector('#recipes-modal-close');
  const modalCancel     = containerEl.querySelector('#recipes-modal-cancel');
  const modalSave       = containerEl.querySelector('#recipes-modal-save');
  const nameInput       = containerEl.querySelector('#recipe-name-input');
  const typeSelect      = containerEl.querySelector('#recipe-type-select');
  const descTextarea    = containerEl.querySelector('#recipe-desc-textarea');
  const configTextarea  = containerEl.querySelector('#recipe-config-textarea');
  const formError       = containerEl.querySelector('#recipe-form-error');
  const modalTitle      = containerEl.querySelector('#recipes-modal-title');

  // ── Render starters ────────────────────────────────────────────────────────
  startersGrid.innerHTML = STARTER_RECIPES.map(r => buildCardHTML(r, true)).join('');
  attachCardEvents(startersGrid, true);

  // ── Render user recipes ────────────────────────────────────────────────────
  function renderUserRecipes() {
    const recipes = state.recipes || [];
    if (recipes.length === 0) {
      emptyState.hidden = false;
      // Remove all cards except empty state
      userGrid.querySelectorAll('.recipe-card').forEach(c => c.remove());
      return;
    }
    emptyState.hidden = true;
    userGrid.innerHTML = recipes.map(r => buildCardHTML(r, false)).join('');
    attachCardEvents(userGrid, false);
  }

  // ── Card HTML builder ──────────────────────────────────────────────────────
  function buildCardHTML(recipe, isStarter) {
    const typeLabel = {
      'rename':          'Rename',
      'archive':         'Archive',
      'metadata-export': 'Metadata',
      'custom':          'Custom',
    }[recipe.type] || recipe.type;

    const date = recipe.createdAt ? formatDate(new Date(recipe.createdAt)) : '';

    const actions = isStarter
      ? `<button class="btn btn-sm btn-secondary recipe-action-apply" data-id="${recipe.id}">Use Template</button>`
      : `
        <button class="btn btn-sm btn-primary recipe-action-apply" data-id="${recipe.id}">Apply</button>
        <button class="btn btn-sm btn-secondary recipe-action-duplicate" data-id="${recipe.id}">Duplicate</button>
        <button class="btn btn-sm btn-ghost recipe-action-delete" data-id="${recipe.id}">Delete</button>`;

    return `
      <div class="recipe-card${isStarter ? ' recipe-card--starter' : ''}" data-id="${recipe.id}">
        <div class="recipe-card-header">
          <span class="recipe-name">${escapeHtml(recipe.name)}</span>
          <span class="recipe-type-badge recipe-type-${recipe.type}">${escapeHtml(typeLabel)}</span>
        </div>
        <p class="recipe-description">${escapeHtml(recipe.description || '')}</p>
        ${!isStarter && date ? `<span class="recipe-date">${date}</span>` : ''}
        <div class="recipe-card-actions">${actions}</div>
      </div>`;
  }

  // ── Card event binding ─────────────────────────────────────────────────────
  function attachCardEvents(grid, isStarter) {
    grid.querySelectorAll('.recipe-action-apply').forEach(btn => {
      btn.addEventListener('click', () => {
        const source = isStarter
          ? STARTER_RECIPES.find(r => r.id === btn.dataset.id)
          : (state.recipes || []).find(r => r.id === btn.dataset.id);
        if (!source) return;
        applyRecipe(source);
        showToast(`Recipe "${source.name}" applied.`, 'success');
      });
    });

    if (!isStarter) {
      grid.querySelectorAll('.recipe-action-duplicate').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await duplicateRecipe(btn.dataset.id);
            renderUserRecipes();
            showToast('Recipe duplicated.', 'success');
          } catch (err) {
            showToast(`Error: ${err.message}`, 'error');
          }
        });
      });

      grid.querySelectorAll('.recipe-action-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          const recipe = (state.recipes || []).find(r => r.id === btn.dataset.id);
          const name   = recipe ? recipe.name : 'this recipe';
          const confirmed = await showConfirm(`Delete "${escapeHtml(name)}"? This cannot be undone.`);
          if (!confirmed) return;
          try {
            await deleteRecipe(btn.dataset.id);
            renderUserRecipes();
            showToast('Recipe deleted.', 'success');
          } catch (err) {
            showToast(`Error: ${err.message}`, 'error');
          }
        });
      });
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function openModal(prefill = null) {
    modalTitle.textContent = prefill ? 'Edit Recipe' : 'Create Recipe';
    nameInput.value        = prefill ? prefill.name : '';
    typeSelect.value       = prefill ? prefill.type : 'rename';
    descTextarea.value     = prefill ? prefill.description : '';
    configTextarea.value   = prefill && prefill.config && Object.keys(prefill.config).length > 0
      ? JSON.stringify(prefill.config, null, 2)
      : '';
    formError.hidden = true;
    formError.textContent = '';
    modalBackdrop.hidden = false;
    nameInput.focus();
  }

  function closeModal() {
    modalBackdrop.hidden = true;
  }

  createBtn.addEventListener('click', () => openModal());
  emptyCreateBtn.addEventListener('click', () => openModal());
  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeModal(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modalBackdrop.hidden) closeModal();
  });

  modalSave.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      formError.textContent = 'Please enter a recipe name.';
      formError.hidden = false;
      nameInput.focus();
      return;
    }

    let config = {};
    const rawConfig = configTextarea.value.trim();
    if (rawConfig) {
      try {
        config = JSON.parse(rawConfig);
        if (typeof config !== 'object' || Array.isArray(config)) {
          throw new Error('Config must be a JSON object.');
        }
      } catch (err) {
        formError.textContent = `Invalid JSON config: ${err.message}`;
        formError.hidden = false;
        configTextarea.focus();
        return;
      }
    }

    formError.hidden = true;
    modalSave.disabled = true;
    modalSave.textContent = 'Saving…';

    try {
      await saveCurrentRecipe({
        name,
        type:        typeSelect.value,
        description: descTextarea.value.trim(),
        config,
      });
      renderUserRecipes();
      closeModal();
      showToast(`Recipe "${name}" saved.`, 'success');
    } catch (err) {
      formError.textContent = `Save failed: ${err.message}`;
      formError.hidden = false;
    } finally {
      modalSave.disabled = false;
      modalSave.textContent = 'Save Recipe';
    }
  });

  // ── Listen for recipe updates from other modules ───────────────────────────
  on('recipes:loaded', () => renderUserRecipes());

  // ── Initial load ───────────────────────────────────────────────────────────
  loadRecipes().then(() => renderUserRecipes()).catch(err => {
    showToast('Could not load recipes from storage.', 'error');
    console.error('initRecipesModule:', err);
  });
}
