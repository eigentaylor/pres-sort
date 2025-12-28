/*
  Presidential Picker Mode
  Approval-voting style sorting inspired by https://www.dragonflycave.com/favorite.html
  
  Users pick their favorites from batches that whittle down over time.
  Favorites are ranked as they're found and can be reordered in real-time.
*/

const PICKER_CONFIG = {
    MAX_BATCH_SIZE: 6,      // Maximum items shown at once (2x3 grid)
    MIN_BATCH_SIZE: 2,      // Minimum batch size
    WHITTLE_DIVISOR: 2,     // batch = ceil(remaining / this), clamped to min/max
};

const PICKER_LS_KEY = 'pps.v1.picker';

// --- Picker State -----------------------------------------------------------
class PresidentialPicker {
    constructor(items, options = {}) {
        this.allItems = items.slice(); // all president objects
        this.options = options;

        // State arrays
        this.eliminated = [];      // { id, eliminatedBy: [id, ...] }
        this.survived = [];        // ids that survived current round
        this.current = [];         // ids remaining in current round
        this.evaluating = [];      // ids currently being evaluated
        this.favorites = [];       // found favorites (ranked, best first)

        // History for undo
        this.history = [];
        this.historyIndex = -1;

        // Batch size
        this.batchSize = PICKER_CONFIG.MAX_BATCH_SIZE;

        // Pick counter (excludes passes)
        this.pickCount = 0;

        // Build id->item map
        this.itemMap = new Map(items.map(p => [p.id, p]));
    }

    // Initialize fresh state
    initialize() {
        const ids = this.allItems.map(p => p.id);
        this.shuffle(ids);

        this.eliminated = [];
        this.survived = [];
        this.current = ids.slice();
        this.evaluating = [];
        this.favorites = [];
        this.history = [];
        this.historyIndex = -1;
        this.pickCount = 0;

        this.batchSize = this.calculateBatchSize(this.current.length);
        this.nextBatch();
        this.saveState();
    }

    // Fisher-Yates shuffle
    shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // Calculate ideal batch size based on remaining items
    calculateBatchSize(remaining) {
        const ideal = Math.ceil(remaining / PICKER_CONFIG.WHITTLE_DIVISOR);
        return Math.max(
            PICKER_CONFIG.MIN_BATCH_SIZE,
            Math.min(PICKER_CONFIG.MAX_BATCH_SIZE, ideal)
        );
    }

    // Move to next batch of items to evaluate
    // This matches the original picker.js logic
    nextBatch() {
        console.log('[nextBatch] START - current:', this.current.length, 'survived:', this.survived.length, 'eliminated:', this.eliminated.length, 'favorites:', this.favorites.length);

        // Safety check: if we're stuck (nothing in current/survived but have eliminated items),
        // restore all eliminated items to continue
        if (this.current.length === 0 && this.survived.length === 0 && this.eliminated.length > 0) {
            console.log('[nextBatch] Stuck with no items but', this.eliminated.length, 'eliminated. Restoring all.');
            for (const entry of this.eliminated) {
                this.survived.push(entry.id);
            }
            this.eliminated = [];
        }

        // If current doesn't have enough items but survived does, start new round
        // The original checks: current.length < batchSize && survived.length > 0
        if (this.current.length < this.batchSize && this.survived.length > 0) {
            console.log('[nextBatch] Not enough in current, starting new round');
            this.nextRound();
            return; // nextRound will call nextBatch again
        }

        // Take the next batch from current
        this.evaluating = this.current.splice(0, this.batchSize);
        console.log('[nextBatch] END - created batch of', this.evaluating.length);
    }

    // Start a new round with survived items
    // This matches the original picker.js logic from dragonflycave
    nextRound() {
        console.log('[nextRound] START - current:', this.current.length, 'survived:', this.survived.length, 'eliminated:', this.eliminated.length);

        // If we've only got one item left in survived (and current is empty), 
        // then it's our next favorite - add it to favorites and then start 
        // the next round with the new survivors (items restored from eliminated).
        if (this.current.length === 0 && this.survived.length === 1) {
            const newFavorite = this.survived[0];
            console.log('[nextRound] Found new favorite!', newFavorite);
            this.survived = []; // Clear BEFORE addToFavorites so restored items go to a clean survived
            this.addToFavorites(newFavorite);
            // addToFavorites restores items to survived, continue below to merge them into current
        }

        console.log('[nextRound] After favorite processing - survived:', this.survived.length);

        // Shuffle survived and merge into current
        this.shuffle(this.survived);
        this.current = this.current.concat(this.survived.splice(0, this.survived.length));

        // Pick an appropriate batch size for this new round
        this.batchSize = this.calculateBatchSize(this.current.length);
        console.log('[nextRound] New round started - current:', this.current.length, 'batchSize:', this.batchSize);

        // Continue to next batch
        this.nextBatch();
    }

    // Add item to favorites and restore any items that were only eliminated by it
    // This matches the original addToFavorites + removeFromEliminated logic
    addToFavorites(id) {
        if (!this.favorites.includes(id)) {
            this.favorites.push(id);
        }
        this.removeFromEliminated(id);
    }

    // Remove this item from all eliminatedBy lists.
    // Any items left with empty eliminatedBy are restored to survived.
    removeFromEliminated(favoriteId) {
        console.log('[removeFromEliminated] Removing', favoriteId, 'from eliminatedBy lists');
        let restoredCount = 0;

        for (let i = this.eliminated.length - 1; i >= 0; i--) {
            const entry = this.eliminated[i];
            const idx = entry.eliminatedBy.indexOf(favoriteId);

            if (idx !== -1) {
                entry.eliminatedBy.splice(idx, 1);

                // If no more eliminators, restore to survived
                if (entry.eliminatedBy.length === 0) {
                    console.log('[removeFromEliminated] Restoring', entry.id, 'to survived');
                    this.survived.push(entry.id);
                    this.eliminated.splice(i, 1);
                    restoredCount++;
                }
            }
        }

        console.log('[removeFromEliminated] Restored', restoredCount, 'items to survived');

        // If nothing was restored but we still have eliminated items and nothing in play,
        // restore all eliminated to continue ranking
        if (restoredCount === 0 && this.eliminated.length > 0 &&
            this.current.length === 0 && this.survived.length === 0) {
            console.log('[removeFromEliminated] No items restored naturally, but', this.eliminated.length, 'remain. Restoring all.');
            for (const entry of this.eliminated) {
                this.survived.push(entry.id);
            }
            this.eliminated = [];
        }
    }

    // User picks their favorites from current batch
    pick(pickedIds) {
        console.log('[pick] Picked', pickedIds.length, 'of', this.evaluating.length);
        this.pushHistory();
        this.pickCount++;

        const pickedSet = new Set(pickedIds);
        const notPicked = this.evaluating.filter(id => !pickedSet.has(id));

        // Special case: if this is the FINAL choice (only 2 items remain total),
        // add both to favorites immediately (picked one first, then unpicked)
        const totalRemaining = this.current.length + this.survived.length + this.evaluating.length + this.eliminated.length;
        if (totalRemaining === 2 && this.evaluating.length === 2 && pickedIds.length === 1) {
            console.log('[pick] Final choice - adding both items to favorites');
            // Add picked one first (higher rank)
            this.favorites.push(pickedIds[0]);
            // Add unpicked one last (lower rank)
            this.favorites.push(notPicked[0]);
            this.evaluating = [];
            this.saveState();
            return;
        }

        // Picked items survive
        this.survived.push(...pickedIds);
        console.log('[pick] Survived now:', this.survived.length);

        // Not-picked items are eliminated (by the picked ones)
        for (const id of notPicked) {
            this.eliminated.push({
                id,
                eliminatedBy: pickedIds.slice()
            });
        }
        console.log('[pick] Eliminated now:', this.eliminated.length);

        this.evaluating = [];
        this.nextBatch();
        this.saveState();
    }

    // Pass: all items survive (equivalent to picking everything)
    pass() {
        console.log('[pass] Passing all', this.evaluating.length, 'items');
        this.pushHistory();
        this.survived.push(...this.evaluating);
        this.evaluating = [];
        this.nextBatch();
        this.saveState();
    }

    // --- History (Undo/Redo) ---
    pushHistory() {
        // Truncate any redo history
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }

        this.history.push(this.getStateSnapshot());
        this.historyIndex = this.history.length - 1;

        // Limit history size
        if (this.history.length > 50) {
            this.history.shift();
            this.historyIndex--;
        }
    }

    getStateSnapshot() {
        return JSON.stringify({
            eliminated: this.eliminated,
            survived: this.survived,
            current: this.current,
            evaluating: this.evaluating,
            favorites: this.favorites,
            batchSize: this.batchSize,
            pickCount: this.pickCount
        });
    }

    restoreSnapshot(snapshot) {
        const s = JSON.parse(snapshot);
        this.eliminated = s.eliminated;
        this.survived = s.survived;
        this.current = s.current;
        this.evaluating = s.evaluating;
        this.favorites = s.favorites;
        this.batchSize = s.batchSize;
        this.pickCount = s.pickCount || 0;
    }

    canUndo() {
        return this.historyIndex >= 0;
    }

    canRedo() {
        return this.historyIndex < this.history.length - 1;
    }

    undo() {
        if (!this.canUndo()) return false;

        // Save current state for redo if we're at the end
        if (this.historyIndex === this.history.length - 1) {
            this.history.push(this.getStateSnapshot());
        }

        this.restoreSnapshot(this.history[this.historyIndex]);
        this.historyIndex--;
        this.saveState();
        return true;
    }

    redo() {
        if (!this.canRedo()) return false;
        this.historyIndex++;
        this.restoreSnapshot(this.history[this.historyIndex + 1]);
        this.saveState();
        return true;
    }

    // --- Persistence ---
    saveState() {
        const data = {
            eliminated: this.eliminated,
            survived: this.survived,
            current: this.current,
            evaluating: this.evaluating,
            favorites: this.favorites,
            batchSize: this.batchSize,
            pickCount: this.pickCount,
            historyIndex: this.historyIndex,
            history: this.history
        };
        localStorage.setItem(PICKER_LS_KEY, JSON.stringify(data));
    }

    loadState() {
        const raw = localStorage.getItem(PICKER_LS_KEY);
        if (!raw) return false;

        try {
            const s = JSON.parse(raw);
            this.eliminated = s.eliminated || [];
            this.survived = s.survived || [];
            this.current = s.current || [];
            this.evaluating = s.evaluating || [];
            this.favorites = s.favorites || [];
            this.batchSize = s.batchSize || PICKER_CONFIG.MAX_BATCH_SIZE;
            this.pickCount = s.pickCount || 0;
            this.history = s.history || [];
            this.historyIndex = s.historyIndex ?? -1;

            // Validate: if evaluating is invalid (< 2 items), regenerate it
            if (this.evaluating.length < 2 && !this.isComplete()) {
                console.warn('Loaded invalid state (batch < 2), regenerating batch...');
                this.nextBatch();
            }

            return true;
        } catch {
            return false;
        }
    }

    clearState() {
        localStorage.removeItem(PICKER_LS_KEY);
    }

    // --- Getters ---
    getEvaluating() {
        return this.evaluating.map(id => this.itemMap.get(id)).filter(Boolean);
    }

    getFavorites() {
        return this.favorites.map(id => this.itemMap.get(id)).filter(Boolean);
    }

    getProgress() {
        const total = this.allItems.length;
        const found = this.favorites.length;
        const remaining = this.current.length + this.survived.length + this.evaluating.length + this.eliminated.length;

        // Progress based on how many are found vs how many could still be found
        if (remaining === 0 && found > 0) return 100;
        if (total === 0) return 0;
        return Math.round((found / total) * 100);
    }

    isComplete() {
        // Complete when all items have been ranked as favorites
        // OR when there are no more items to evaluate and we've found at least one favorite
        const allRanked = this.favorites.length === this.allItems.length;
        const nothingLeft = this.evaluating.length === 0 &&
            this.current.length === 0 &&
            this.survived.length === 0 &&
            this.eliminated.length === 0;

        return allRanked || (nothingLeft && this.favorites.length > 0);
    }

    hasItems() {
        return this.allItems.length > 0;
    }

    getRemainingCount() {
        return this.current.length + this.survived.length + this.evaluating.length + this.eliminated.length;
    }

    // Find where a president is located
    findPresidentLocation(id) {
        if (this.favorites.includes(id)) {
            const position = this.favorites.indexOf(id) + 1;
            return `Found in your favorites at position ${position}!`;
        }
        if (this.evaluating.includes(id)) {
            return 'Currently in the batch you\'re evaluating.';
        }
        if (this.current.includes(id)) {
            return 'Waiting in the current round.';
        }
        if (this.survived.includes(id)) {
            return 'Has survived this round and will appear in the next round.';
        }
        const eliminated = this.eliminated.find(e => e.id === id);
        if (eliminated) {
            const eliminators = eliminated.eliminatedBy.map(eid => {
                const person = this.itemMap.get(eid);
                return person ? person.name : eid;
            });
            return `Was eliminated because you preferred: ${eliminators.join(', ')}. It will return if any of those become favorites.`;
        }
        return 'Not found in current state.';
    }

    // Reorder favorites (for drag-and-drop)
    reorderFavorites(newOrder) {
        // newOrder is array of ids in new order
        this.favorites = newOrder.filter(id => this.favorites.includes(id));
        this.saveState();
    }

    // Reset to beginning
    reset() {
        this.clearState();
        this.initialize();
    }
}

// --- Picker UI --------------------------------------------------------------
class PickerUI {
    constructor(picker, elements) {
        this.picker = picker;
        this.elem = elements;
        this.selected = new Set();
        this.favoritesSortable = null;

        // Image cache: id -> successful image URL
        this.imageCache = new Map();
        this.imagesPreloaded = false;

        this.messages = {
            mustSelect: "Pick at least one favorite, or press Pass if you can't decide.",
            allSelected: "Picking ALL items is the same as Pass. Use Pass button instead, or deselect some.",
            orderedAll: "You've found all your favorites!",
            noItems: "No items to sort."
        };
    }

    async initialize() {
        this.bindEvents();
        await this.preloadImages();
        this.update();
        this.initFavoritesSortable();
    }

    async preloadImages() {
        console.log('Preloading images for', this.picker.allItems.length, 'presidents...');
        const startTime = Date.now();

        const promises = this.picker.allItems.map(person => {
            return new Promise((resolve) => {
                const candidates = this.getImageCandidates(person);
                this.findWorkingImage(candidates).then(url => {
                    if (url) {
                        this.imageCache.set(person.id, url);
                        // Also cache on person object for consistency with main app
                        person._resolved = url;
                    }
                    resolve();
                });
            });
        });

        await Promise.all(promises);
        this.imagesPreloaded = true;
        const elapsed = Date.now() - startTime;
        console.log(`Preloaded ${this.imageCache.size}/${this.picker.allItems.length} images in ${elapsed}ms`);
    }

    async findWorkingImage(candidates) {
        for (const url of candidates) {
            try {
                const loaded = await this.testImage(url);
                if (loaded) return url;
            } catch {
                // Try next candidate
            }
        }
        return null;
    }

    testImage(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            // Set timeout to prevent hanging
            setTimeout(() => resolve(false), 3000);
            img.src = url;
        });
    }

    showFindDialog() {
        const searchTerm = prompt('Enter president name or number to search:');
        if (!searchTerm) return;

        const term = searchTerm.toLowerCase().trim();

        // Try to match by name or number
        const matches = this.picker.allItems.filter(p => {
            const name = p.name.toLowerCase();
            const num = String(p.num);
            return name.includes(term) || num === term;
        });

        if (matches.length === 0) {
            alert(`No president found matching "${searchTerm}".`);
            return;
        }

        if (matches.length === 1) {
            const location = this.picker.findPresidentLocation(matches[0].id);
            alert(`${matches[0].name}: ${location}`);
        } else {
            // Multiple matches, show list
            const matchList = matches.map(p => {
                const loc = this.picker.findPresidentLocation(p.id);
                return `${p.name}: ${loc}`;
            }).join('\n\n');
            alert(`Multiple matches found:\n\n${matchList}`);
        }
    }

    getPresidentialNumber(person) {
        // Special handling for presidents with non-consecutive terms
        if (person.id === 'cleveland') {
            return '#22 & 24';
        }
        if (person.id === 'trump') {
            return '#45 & 47';
        }
        return person.number != null ? `#${person.number}` : '';
    }

    copyFavoritesList() {
        const favorites = this.picker.getFavorites();

        if (favorites.length === 0) {
            alert('No favorites yet!');
            return;
        }

        // Format as numbered list with presidential numbers
        const listText = favorites.map((person, index) => {
            const presNum = this.getPresidentialNumber(person);
            return `${index + 1}. ${person.name} ${presNum}`;
        }).join('\n');

        // Copy to clipboard
        navigator.clipboard.writeText(listText).then(() => {
            // Visual feedback
            const btn = this.elem.copyList;
            const originalText = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => {
                btn.textContent = originalText;
            }, 2000);
        }).catch(err => {
            console.error('Failed to copy:', err);
            alert('Failed to copy to clipboard');
        });
    }

    bindEvents() {
        // Item selection via delegation
        this.elem.evaluating.addEventListener('click', (e) => {
            const item = e.target.closest('.picker-item');
            if (item) {
                e.preventDefault();
                this.toggleSelect(item);
            }
        });

        // Double-click to pick just that item
        this.elem.evaluating.addEventListener('dblclick', (e) => {
            const item = e.target.closest('.picker-item');
            if (item) {
                e.preventDefault();
                const id = item.dataset.id;
                // If nothing or only this is selected, pick it
                if (this.selected.size === 0 || (this.selected.size === 1 && this.selected.has(id))) {
                    this.selected.clear();
                    this.selected.add(id);
                    this.pick();
                }
            }
        });

        // Pick button
        this.elem.pick.addEventListener('click', (e) => {
            e.preventDefault();
            this.pick();
        });

        // Pass button
        this.elem.pass.addEventListener('click', (e) => {
            e.preventDefault();
            this.pass();
        });

        // Undo button
        this.elem.undo.addEventListener('click', (e) => {
            e.preventDefault();
            this.undo();
        });

        // Redo button  
        this.elem.redo.addEventListener('click', (e) => {
            e.preventDefault();
            this.redo();
        });

        // Reset button
        if (this.elem.reset) {
            this.elem.reset.addEventListener('click', (e) => {
                e.preventDefault();
                this.reset();
            });
        }

        // Done button (go to results/tiers)
        if (this.elem.done) {
            this.elem.done.addEventListener('click', (e) => {
                e.preventDefault();
                this.finish();
            });
        }

        // Cancel button
        if (this.elem.cancel) {
            this.elem.cancel.addEventListener('click', (e) => {
                e.preventDefault();
                this.cancel();
            });
        }

        // Find president button
        if (this.elem.find) {
            this.elem.find.addEventListener('click', (e) => {
                e.preventDefault();
                this.showFindDialog();
            });
        }

        // Copy list button
        if (this.elem.copyList) {
            this.elem.copyList.addEventListener('click', (e) => {
                e.preventDefault();
                this.copyFavoritesList();
            });
        }
    }

    initFavoritesSortable() {
        if (typeof Sortable === 'undefined') return;

        this.favoritesSortable = new Sortable(this.elem.favorites, {
            animation: 150,
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            onEnd: () => {
                // Get new order from DOM
                const items = this.elem.favorites.querySelectorAll('.picker-fav-item');
                const newOrder = Array.from(items).map(el => el.dataset.id);
                this.picker.reorderFavorites(newOrder);
                this.updateRankNumbers();
            }
        });
    }

    toggleSelect(elem) {
        const id = elem.dataset.id;
        if (this.selected.has(id)) {
            this.selected.delete(id);
            elem.classList.remove('selected');
        } else {
            this.selected.add(id);
            elem.classList.add('selected');
        }
        this.updatePickButton();
    }

    updatePickButton() {
        const count = this.selected.size;
        const total = this.picker.evaluating.length;

        if (count === 0) {
            this.elem.pickHint.textContent = 'Select favorites to continue';
            this.elem.pick.disabled = true;
        } else if (count === total) {
            this.elem.pickHint.textContent = this.messages.allSelected;
            this.elem.pick.disabled = true;
        } else {
            this.elem.pickHint.textContent = `${count} selected`;
            this.elem.pick.disabled = false;
        }
    }

    pick() {
        if (this.selected.size === 0) {
            this.showNotice(this.messages.mustSelect);
            return;
        }
        if (this.selected.size === this.picker.evaluating.length) {
            this.showNotice(this.messages.allSelected);
            return;
        }

        const picked = Array.from(this.selected);
        this.selected.clear();
        this.picker.pick(picked);
        this.update();
    }

    pass() {
        this.selected.clear();
        this.picker.pass();
        this.update();
    }

    undo() {
        if (this.picker.undo()) {
            this.selected.clear();
            this.update();
        }
    }

    redo() {
        if (this.picker.redo()) {
            this.selected.clear();
            this.update();
        }
    }

    reset() {
        if (confirm('Reset all progress? Your found favorites will be lost.')) {
            this.picker.reset();
            this.selected.clear();
            this.update();
        }
    }

    finish() {
        // Transition to results/tier screen with favorites as the ranking
        if (typeof window.pickerFinishCallback === 'function') {
            window.pickerFinishCallback(this.picker.getFavorites());
        }
    }

    cancel() {
        if (typeof window.pickerCancelCallback === 'function') {
            window.pickerCancelCallback();
        }
    }

    showNotice(msg) {
        // Brief toast or inline notice
        if (this.elem.notice) {
            this.elem.notice.textContent = msg;
            this.elem.notice.hidden = false;
            setTimeout(() => { this.elem.notice.hidden = true; }, 2500);
        } else {
            alert(msg);
        }
    }

    update() {
        // Ensure we have a valid batch before updating UI
        if (this.picker.evaluating.length < 2 && !this.picker.isComplete()) {
            console.warn('[UI update] Invalid batch detected:', this.picker.evaluating.length, 'items. State:', {
                current: this.picker.current.length,
                survived: this.picker.survived.length,
                eliminated: this.picker.eliminated.length,
                favorites: this.picker.favorites.length
            });
            console.warn('[UI update] Attempting to regenerate batch...');
            this.picker.nextBatch();
            console.log('[UI update] After regeneration:', this.picker.evaluating.length, 'items');
        }

        this.updateEvaluating();
        this.updateFavorites();
        this.updateProgress();
        this.updateHistoryButtons();
        this.updatePickButton();
        this.updateStatus();
    }

    updateEvaluating() {
        this.elem.evaluating.innerHTML = '';

        const batch = this.picker.getEvaluating();

        if (batch.length === 0) {
            if (this.picker.isComplete()) {
                const notice = document.createElement('div');
                notice.className = 'picker-notice';
                notice.innerHTML = this.picker.hasItems()
                    ? `<p>${this.messages.orderedAll}</p><button class="btn" id="picker-reset-inline">Start Over</button>`
                    : `<p>${this.messages.noItems}</p>`;
                this.elem.evaluating.appendChild(notice);

                const resetBtn = notice.querySelector('#picker-reset-inline');
                if (resetBtn) {
                    resetBtn.addEventListener('click', () => this.reset());
                }

                this.elem.pick.disabled = true;
                this.elem.pass.disabled = true;
            }
            return;
        }

        // Edge case: if somehow only 1 item in batch, automatically pass it
        if (batch.length === 1) {
            console.warn('Batch size of 1 detected, auto-passing...');
            setTimeout(() => {
                this.picker.pass();
                this.update();
            }, 100);
            return;
        }

        // Create items (grid will auto-fit them with consistent sizing)
        for (const person of batch) {
            const el = this.createItemElement(person);
            this.elem.evaluating.appendChild(el);
        }

        this.elem.pick.disabled = true; // Until something is selected
        this.elem.pass.disabled = false;
    }

    createItemElement(person) {
        const el = document.createElement('div');
        el.className = 'picker-item';
        el.dataset.id = person.id;

        // Image container
        const imgWrap = document.createElement('div');
        imgWrap.className = 'picker-img-wrap';

        // Use cached image if available
        const cachedUrl = this.imageCache.get(person.id);
        if (cachedUrl) {
            const img = document.createElement('img');
            img.alt = person.name;
            img.src = cachedUrl;
            imgWrap.appendChild(img);
        } else {
            // Fallback to placeholder if no cached image
            const placeholder = document.createElement('div');
            placeholder.className = 'picker-placeholder';
            placeholder.textContent = person.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            imgWrap.appendChild(placeholder);
        }

        // Name label (important for presidents!)
        const name = document.createElement('div');
        name.className = 'picker-name';
        name.textContent = person.name;

        // Number badge
        if (person.number != null) {
            const badge = document.createElement('span');
            badge.className = 'picker-number';
            badge.textContent = this.getPresidentialNumber(person);
            el.appendChild(badge);
        }

        el.appendChild(imgWrap);
        el.appendChild(name);

        return el;
    }

    getImageCandidates(person) {
        const candidates = [];
        if (person.image) candidates.push(person.image);
        if (person._resolved) candidates.push(person._resolved);
        if (person.number != null) {
            // Try various naming patterns
            const num = person.number;
            const numPadded = String(num).padStart(2, '0');
            candidates.push(
                `img/President_${numPadded}.png`,
                `img/President_${num}.png`,
                `img/${numPadded}.jpg`,
                `img/${numPadded}.png`,
                `img/${numPadded}.jpeg`,
                `img/${num}.jpg`,
                `img/${num}.png`,
                `img/${num}.jpeg`
            );
        }
        candidates.push(`img/${person.id}.jpg`, `img/${person.id}.png`, `img/${person.id}.jpeg`);
        return candidates;
    }

    loadImageWithFallback(container, candidates, alt) {
        let index = 0;

        const img = document.createElement('img');
        img.alt = alt;
        img.loading = 'lazy';

        const tryNext = () => {
            if (index >= candidates.length) {
                // All failed, show placeholder
                const placeholder = document.createElement('div');
                placeholder.className = 'picker-placeholder';
                placeholder.textContent = alt.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
                container.appendChild(placeholder);
                return;
            }
            img.src = candidates[index++];
        };

        img.onload = () => {
            container.appendChild(img);
        };

        img.onerror = tryNext;
        tryNext();
    }

    updateFavorites() {
        const favorites = this.picker.getFavorites();

        // Clear and rebuild
        this.elem.favorites.innerHTML = '';

        if (favorites.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'picker-fav-empty';
            empty.textContent = 'Your favorites will appear here';
            this.elem.favorites.appendChild(empty);

            // Disable buttons when no favorites
            if (this.elem.done) {
                this.elem.done.disabled = true;
            }
            if (this.elem.copyList) {
                this.elem.copyList.disabled = true;
            }
            return;
        }

        favorites.forEach((person, index) => {
            const el = this.createFavoriteElement(person, index + 1);
            this.elem.favorites.appendChild(el);
        });

        // Enable buttons when there are favorites
        if (this.elem.done) {
            this.elem.done.disabled = false;
        }
        if (this.elem.copyList) {
            this.elem.copyList.disabled = false;
        }
    }

    createFavoriteElement(person, rank) {
        const el = document.createElement('div');
        el.className = 'picker-fav-item';
        el.dataset.id = person.id;

        const rankEl = document.createElement('span');
        rankEl.className = 'picker-fav-rank';
        rankEl.textContent = rank;

        const imgWrap = document.createElement('div');
        imgWrap.className = 'picker-fav-img';

        // Use cached image if available
        const cachedUrl = this.imageCache.get(person.id);
        if (cachedUrl) {
            const img = document.createElement('img');
            img.alt = person.name;
            img.src = cachedUrl;
            imgWrap.appendChild(img);
        } else {
            // Fallback to placeholder
            const placeholder = document.createElement('div');
            placeholder.className = 'picker-placeholder';
            placeholder.style.fontSize = '1rem';
            placeholder.textContent = person.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            imgWrap.appendChild(placeholder);
        }

        const name = document.createElement('span');
        name.className = 'picker-fav-name';
        name.textContent = person.name;

        // Number badge for favorites
        const numberBadge = document.createElement('span');
        numberBadge.className = 'picker-fav-number';
        numberBadge.textContent = this.getPresidentialNumber(person);

        el.appendChild(rankEl);
        el.appendChild(imgWrap);
        el.appendChild(name);
        el.appendChild(numberBadge);

        return el;
    }

    updateRankNumbers() {
        const items = this.elem.favorites.querySelectorAll('.picker-fav-item');
        items.forEach((el, i) => {
            const rank = el.querySelector('.picker-fav-rank');
            if (rank) rank.textContent = i + 1;
        });
    }

    updateProgress() {
        const pct = this.picker.getProgress();
        const remaining = this.picker.getRemainingCount();
        const found = this.picker.favorites.length;

        if (this.elem.progressBar) {
            this.elem.progressBar.style.width = `${pct}%`;
            this.elem.progressBar.setAttribute('aria-valuenow', pct);
        }

        if (this.elem.progressText) {
            this.elem.progressText.textContent = `${found} found · ${remaining} remaining`;
        }
    }

    updateHistoryButtons() {
        this.elem.undo.disabled = !this.picker.canUndo();
        this.elem.undo.classList.toggle('disabled', !this.picker.canUndo());

        this.elem.redo.disabled = !this.picker.canRedo();
        this.elem.redo.classList.toggle('disabled', !this.picker.canRedo());
    }

    updateStatus() {
        if (this.elem.status) {
            const batch = this.picker.evaluating.length;
            const inRound = this.picker.current.length + this.picker.survived.length + batch;
            const eliminated = this.picker.eliminated.length;
            const picks = this.picker.pickCount;

            if (batch > 0) {
                let statusText = `Pick your favorites from these ${batch}.`;
                if (inRound > batch) {
                    statusText += ` (${inRound} left in this round)`;
                }
                if (eliminated > 0) {
                    statusText += ` • ${eliminated} eliminated (may return later)`;
                }
                statusText += ` • ${picks} ${picks === 1 ? 'pick' : 'picks'} made`;
                statusText += ' • Double-click to pick just one.';
                this.elem.status.textContent = statusText;
            } else if (this.picker.isComplete()) {
                this.elem.status.textContent = `Sorting complete! You made ${picks} ${picks === 1 ? 'choice' : 'choices'}. Drag to reorder your favorites.`;
            }
        }
    }
}

// --- Integration with main app ---------------------------------------------
let pickerInstance = null;
let pickerUI = null;

async function initPickerMode(data) {
    // Show loading message
    const statusEl = document.getElementById('picker-status');
    const gridEl = document.getElementById('picker-grid');
    if (statusEl) statusEl.textContent = 'Loading images...';
    if (gridEl) gridEl.innerHTML = '<div class="picker-notice"><p>Preloading images, please wait...</p></div>';

    // Create picker with president data
    pickerInstance = new PresidentialPicker(data);

    // Check for saved state
    if (!pickerInstance.loadState()) {
        pickerInstance.initialize();
    }

    // Get UI elements
    const elements = {
        evaluating: document.getElementById('picker-grid'),
        favorites: document.getElementById('picker-favorites'),
        pick: document.getElementById('picker-pick'),
        pass: document.getElementById('picker-pass'),
        undo: document.getElementById('picker-undo'),
        redo: document.getElementById('picker-redo'),
        reset: document.getElementById('picker-reset'),
        done: document.getElementById('picker-done'),
        cancel: document.getElementById('picker-cancel'),
        find: document.getElementById('picker-find'),
        copyList: document.getElementById('picker-copy-list'),
        progressBar: document.getElementById('picker-progress-bar'),
        progressText: document.getElementById('picker-progress-text'),
        status: document.getElementById('picker-status'),
        notice: document.getElementById('picker-notice'),
        pickHint: document.getElementById('picker-pick-hint')
    };

    pickerUI = new PickerUI(pickerInstance, elements);
    await pickerUI.initialize();

    return { picker: pickerInstance, ui: pickerUI };
}

function resetPickerState() {
    localStorage.removeItem(PICKER_LS_KEY);
    pickerInstance = null;
    pickerUI = null;
}

// Export for use by main app
window.PresidentialPicker = PresidentialPicker;
window.PickerUI = PickerUI;
window.initPickerMode = initPickerMode;
window.resetPickerState = resetPickerState;
window.PICKER_CONFIG = PICKER_CONFIG;
