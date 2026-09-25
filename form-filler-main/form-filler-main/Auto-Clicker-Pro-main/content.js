// ========================================================
// Auto Clicker & Form Filler Pro - Content Script
// Full implementation with:
// 1. Shadow DOM & Iframe resilient click & autofill recording
// 2. Accurate Checkbox & Selection Cube Box detection & execution
// 3. 100% Manual controls (NO keyboard shortcuts)
// 4. Rotating Dynamic Paragraphs from TXT files
// 5. Dropdown & Option Box Selection
// 6. Clipboard Pasting Step
// 7. Area Selection & Color/Text Condition Branches
// ========================================================

const contentSend = (msg) => {
    chrome.runtime.sendMessage(msg).catch(() => {});
};

const storageGet = (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve));
const storageSet = (items) => new Promise(resolve => chrome.storage.local.set(items, resolve));

// In-memory state
let recordedSteps = [];
let smartModeCached = true;
let recordingActive = false;
let recordingPaused = false;
let stopExecution = false;
let lastActiveFieldStepIndex = null;
let lastFieldPillEl = null;

// Tracking to prevent duplicate events (e.g. label + input double events)
let lastRecordedTime = 0;
let lastRecordedTarget = null;
let lastPointerDownEl = null;
let lastPointerDownTime = 0;

// Condition branch recording state
let branchRecordingActive = false;
let conditionFlowType = null; // 'color' | 'text'
let conditionFlowState = null; // 'match' | 'nomatch'
let conditionArea = null;
let conditionTargetValue = null;
let branchMatchSteps = [];
let branchNoMatchSteps = [];

// Initialize on load
const init = () => {
    chrome.storage.local.get(['isRecording', 'smartMode', 'steps'], (data) => {
        smartModeCached = data.smartMode !== undefined ? data.smartMode : true;
        recordedSteps = data.steps || [];
        if (data.isRecording) {
            startRecordingLocally();
        }
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Storage synchronization across top window, iframes and popup
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.steps) {
            recordedSteps = changes.steps.newValue || [];
            updateBannerStepCount();
        }
        if (changes.isRecording) {
            if (changes.isRecording.newValue) {
                startRecordingLocally();
            } else {
                stopRecordingLocally();
            }
        }
        if (changes.smartMode !== undefined) {
            smartModeCached = changes.smartMode.newValue;
        }
    }
});

const saveSteps = () => {
    chrome.storage.local.set({ steps: recordedSteps });
};

// ========================================================
// Deep DOM & Shadow Root Navigation Helpers
// ========================================================
const getEventTarget = (e) => {
    if (e.composedPath && typeof e.composedPath === 'function') {
        const path = e.composedPath();
        if (path && path.length > 0) {
            for (const item of path) {
                if (item && item.nodeType === 1) return item;
            }
        }
    }
    return e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement ? e.target.parentElement : null);
};

const querySelectorDeep = (selector, root = document) => {
    if (!selector) return null;
    try {
        const found = root.querySelector(selector);
        if (found) return found;
    } catch (e) {}

    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
        if (el.shadowRoot) {
            const shadowFound = querySelectorDeep(selector, el.shadowRoot);
            if (shadowFound) return shadowFound;
        }
    }
    return null;
};

// ========================================================
// CSS Selector & Resilient Element Identification
// ========================================================
const getElementClassString = (el) => {
    if (!el) return '';
    if (typeof el.className === 'string') return el.className;
    if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
    return el.getAttribute ? (el.getAttribute('class') || '') : '';
};

const getCSSSelector = (el) => {
    if (!el || el === document || el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
    if (el.nodeType !== 1) return '';

    // 1. Direct ID if valid and not dynamically generated noise
    if (el.id && typeof el.id === 'string') {
        const id = el.id.trim();
        if (!/[:\s]/.test(id) && !/^(:r|ember|react-|__)/.test(id) && !/\d{6,}/.test(id)) {
            try {
                const test = document.querySelectorAll(`#${CSS.escape(id)}`);
                if (test.length === 1) return `#${CSS.escape(id)}`;
            } catch (e) {}
        }
    }

    // 2. Name attribute (standard in form fields)
    if (el.name && typeof el.name === 'string') {
        const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
        try {
            if (document.querySelectorAll(sel).length === 1) return sel;
        } catch (e) {}
    }

    // 3. Form input type & name/value (especially for checkboxes & radio buttons)
    if (el.tagName.toLowerCase() === 'input' && el.type) {
        const inputType = el.type.toLowerCase();
        if (el.name) {
            let sel = `input[type="${CSS.escape(inputType)}"][name="${CSS.escape(el.name)}"]`;
            if (el.value && (inputType === 'checkbox' || inputType === 'radio')) {
                const selVal = `${sel}[value="${CSS.escape(el.value)}"]`;
                try {
                    if (document.querySelectorAll(selVal).length === 1) return selVal;
                } catch (e) {}
            }
            try {
                if (document.querySelectorAll(sel).length === 1) return sel;
            } catch (e) {}
        }
    }

    // 4. Data-testid / data-qa / data-id / data-action / data-value
    for (const attr of ['data-testid', 'data-id', 'data-qa', 'data-cy', 'data-action', 'data-value']) {
        const val = el.getAttribute ? el.getAttribute(attr) : null;
        if (val) {
            const sel = `[${attr}="${CSS.escape(val)}"]`;
            try {
                if (document.querySelectorAll(sel).length === 1) return sel;
            } catch (e) {}
        }
    }

    // 5. Role + aria-label
    const role = el.getAttribute ? el.getAttribute('role') : null;
    const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (role && ariaLabel) {
        const sel = `[role="${CSS.escape(role)}"][aria-label="${CSS.escape(ariaLabel)}"]`;
        try {
            if (document.querySelectorAll(sel).length === 1) return sel;
        } catch (e) {}
    } else if (ariaLabel) {
        const sel = `[aria-label="${CSS.escape(ariaLabel)}"]`;
        try {
            if (document.querySelectorAll(sel).length === 1) return sel;
        } catch (e) {}
    }

    // 6. Placeholder
    if (el.placeholder && typeof el.placeholder === 'string') {
        const sel = `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(el.placeholder)}"]`;
        try {
            if (document.querySelectorAll(sel).length === 1) return sel;
        } catch (e) {}
    }

    // 7. Hierarchy traversal fallback with accurate :nth-of-type
    let path = [];
    let current = el;

    while (current && current.nodeType === 1 && current !== document.body && current !== document.documentElement) {
        let selector = current.tagName.toLowerCase();

        if (current.id && !/[:\s]/.test(current.id) && !/^(:r|ember|react-)/.test(current.id)) {
            path.unshift(`#${CSS.escape(current.id)}`);
            break;
        }

        if (current.name && ['input', 'select', 'textarea', 'button'].includes(current.tagName.toLowerCase())) {
            selector += `[name="${CSS.escape(current.name)}"]`;
            path.unshift(selector);
            break;
        }

        const classStr = getElementClassString(current);
        if (classStr) {
            const classes = classStr.trim().split(/\s+/).filter(c => {
                return c.length > 0 && !c.includes(':') && !c.includes('/') && !c.includes('.') && !/^css-/.test(c) && !/^[0-9]/.test(c);
            }).slice(0, 2);
            if (classes.length > 0) {
                selector += `.${classes.map(c => CSS.escape(c)).join('.')}`;
            }
        }

        const parent = current.parentElement;
        if (parent && current.tagName) {
            try {
                const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                if (sameTagSiblings.length > 1) {
                    const typeIndex = sameTagSiblings.indexOf(current) + 1;
                    selector += `:nth-of-type(${typeIndex})`;
                }
            } catch (e) {}
        }

        path.unshift(selector);
        current = current.parentElement;
    }

    const fullSelector = path.join(' > ');
    return fullSelector || (el.tagName ? el.tagName.toLowerCase() : 'body');
};

const getXPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && !/[:\s]/.test(el.id)) return `//*[@id="${el.id}"]`;
    const parts = [];
    while (el && el.nodeType === 1) {
        let index = 0;
        let sibling = el.previousSibling;
        while (sibling) {
            if (sibling.nodeType === 1 && sibling.nodeName === el.nodeName) {
                index++;
            }
            sibling = sibling.previousSibling;
        }
        const tagName = el.nodeName.toLowerCase();
        const pathIndex = index > 0 ? `[${index + 1}]` : '';
        parts.unshift(`${tagName}${pathIndex}`);
        el = el.parentNode;
    }
    return parts.length ? '/' + parts.join('/') : '';
};

// ========================================================
// Form, Option & Checkbox Detection
// ========================================================
const isTextInputField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (el.isContentEditable) return true;
    if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        return ['text', 'email', 'tel', 'url', 'search', 'password', 'number'].includes(type);
    }
    return false;
};

// Resolves associated checkbox input for native, custom, or label cube-boxes
const getAssociatedCheckbox = (el) => {
    if (!el || el.nodeType !== 1) return null;

    // Direct input
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        return el;
    }

    // Role checkbox / radio
    const role = el.getAttribute ? el.getAttribute('role') : null;
    if (role === 'checkbox' || role === 'radio') {
        return el;
    }

    // Label wrapper
    const label = el.closest('label');
    if (label) {
        const input = label.querySelector('input[type="checkbox"], input[type="radio"]');
        if (input) return input;
        if (label.htmlFor) {
            const forEl = document.getElementById(label.htmlFor);
            if (forEl && (forEl.type === 'checkbox' || forEl.type === 'radio')) return forEl;
        }
    }

    // Checkbox container (Bootstrap, Tailwind, Material, Ant Design cube-boxes)
    const wrapper = el.closest('.checkbox, .form-check, .ant-checkbox-wrapper, [class*="checkbox"], [class*="check-box"], [class*="switch"]');
    if (wrapper) {
        const input = wrapper.querySelector('input[type="checkbox"], input[type="radio"]');
        if (input) return input;
    }

    // Adjacent input inside parent
    if (el.parentElement) {
        const siblingInput = el.parentElement.querySelector('input[type="checkbox"], input[type="radio"]');
        if (siblingInput) return siblingInput;
    }

    return null;
};

const isOptionBox = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const role = el.getAttribute ? el.getAttribute('role') : null;
    if (role === 'option' || role === 'menuitem' || role === 'menuitemradio') return true;

    const cls = getElementClassString(el).toLowerCase();
    if (cls.includes('option') || cls.includes('dropdown-item') || cls.includes('select__option') || cls.includes('menu-item')) return true;

    const parentContainer = el.closest('[role="listbox"], [role="menu"], .dropdown-menu, .select-options, ul.options, select');
    if (parentContainer && (el.tagName === 'LI' || el.tagName === 'DIV' || el.tagName === 'SPAN' || el.tagName === 'BUTTON')) {
        return true;
    }
    return false;
};

// ========================================================
// Recording Logic (100% MANUAL - NO SHORTCUTS)
// ========================================================
const startRecordingLocally = () => {
    recordingActive = true;
    recordingPaused = false;
    branchRecordingActive = false;

    document.removeEventListener('click', recordClickHandler, true);
    document.addEventListener('click', recordClickHandler, true);

    document.removeEventListener('pointerdown', recordPointerDownHandler, true);
    document.addEventListener('pointerdown', recordPointerDownHandler, true);

    document.removeEventListener('change', recordChangeHandler, true);
    document.addEventListener('change', recordChangeHandler, true);

    document.removeEventListener('input', recordInputHandler, true);
    document.addEventListener('input', recordInputHandler, true);

    document.removeEventListener('blur', recordBlurHandler, true);
    document.addEventListener('blur', recordBlurHandler, true);

    document.removeEventListener('mouseover', highlightOnHover, true);
    document.addEventListener('mouseover', highlightOnHover, true);

    document.removeEventListener('mouseout', removeHighlight, true);
    document.addEventListener('mouseout', removeHighlight, true);

    // Only render banner in the top frame to avoid duplicates in iframes
    if (window === window.top) {
        showRecordingBanner();
    }
};

const stopRecordingLocally = () => {
    recordingActive = false;
    recordingPaused = false;
    branchRecordingActive = false;

    document.removeEventListener('click', recordClickHandler, true);
    document.removeEventListener('pointerdown', recordPointerDownHandler, true);
    document.removeEventListener('change', recordChangeHandler, true);
    document.removeEventListener('input', recordInputHandler, true);
    document.removeEventListener('blur', recordBlurHandler, true);
    document.removeEventListener('mouseover', highlightOnHover, true);
    document.removeEventListener('mouseout', removeHighlight, true);

    removeHighlight();
    removeFieldPill();
    hideRecordingBanner();
    hideAreaOverlay();
};

// Pointerdown capture tracks active element in case autofill / popup closes before click
const recordPointerDownHandler = (e) => {
    if (!recordingActive || recordingPaused) return;
    const target = getEventTarget(e);
    if (!target) return;
    if (isExtensionUI(target)) return;

    lastPointerDownEl = target;
    lastPointerDownTime = Date.now();
};

const isExtensionUI = (el) => {
    if (!el || !el.closest) return false;
    return !!(
        el.closest('#acp-recorder-banner') ||
        el.closest('.acp-field-pill') ||
        el.closest('.acp-click-indicator') ||
        el.closest('#acp-area-overlay') ||
        el.closest('#acp-color-picker') ||
        el.closest('#acp-text-input') ||
        el.closest('.acp-manual-cond-dialog')
    );
};

// Main Click Handler during recording
const recordClickHandler = (e) => {
    const rawTarget = getEventTarget(e);
    if (!rawTarget || isExtensionUI(rawTarget)) return;
    if (!recordingActive || recordingPaused) return;

    const now = Date.now();

    // Check if this click is on or inside a checkbox / small selection cube box
    const cb = getAssociatedCheckbox(rawTarget);
    if (cb) {
        // Prevent duplicate click within 180ms on the same checkbox (common with <label> and <input>)
        if (lastRecordedTarget === cb && now - lastRecordedTime < 180) {
            return;
        }
        lastRecordedTime = now;
        lastRecordedTarget = cb;

        // Desired state after click (toggled)
        const targetChecked = cb.tagName === 'INPUT' ? cb.checked : (cb.getAttribute('aria-checked') !== 'true');

        createClickIndicator(e.pageX, e.pageY, 'smart');

        const step = {
            action: 'smartClick',
            isCheckbox: true,
            targetChecked: targetChecked,
            selector: getCSSSelector(rawTarget),
            inputSelector: cb !== rawTarget ? getCSSSelector(cb) : undefined,
            xpath: getXPath(rawTarget),
            tagName: rawTarget.tagName || 'INPUT',
            elementText: (rawTarget.textContent || (rawTarget.closest('label') ? rawTarget.closest('label').textContent : '') || '').trim().substring(0, 60),
            nameAttr: cb.name || rawTarget.name || undefined,
            idAttr: cb.id || rawTarget.id || undefined,
            delay: 1000,
            x: e.clientX,
            y: e.clientY
        };

        if (branchRecordingActive) {
            if (conditionFlowState === 'match') {
                branchMatchSteps.push(step);
                showBannerToast(`Match Checkbox #${branchMatchSteps.length} recorded`);
            } else {
                branchNoMatchSteps.push(step);
                showBannerToast(`No-Match Checkbox #${branchNoMatchSteps.length} recorded`);
            }
            return;
        }

        recordedSteps.push(step);
        saveSteps();
        showBannerToast(`Checkbox: ${targetChecked ? 'Checked ☑' : 'Unchecked ☐'}`);
        return;
    }

    // Resolve interactive element (e.g. if user clicked SVG, path, icon inside button or link)
    const el = rawTarget.closest('button, a, select, textarea, input, [role="button"], [role="option"], [role="menuitem"], [role="tab"], label') || rawTarget;

    // Prevent rapid duplicate clicks on the exact same element within 150ms
    if (lastRecordedTarget === el && now - lastRecordedTime < 150) {
        return;
    }
    lastRecordedTime = now;
    lastRecordedTarget = el;

    createClickIndicator(e.pageX, e.pageY, isOptionBox(el) ? 'option' : (isTextInputField(el) ? 'fill' : 'smart'));

    // --- Branch Recording Mode ---
    if (branchRecordingActive) {
        const branchStep = {
            action: 'smartClick',
            selector: getCSSSelector(el),
            xpath: getXPath(el),
            tagName: el.tagName || '',
            elementText: (el.textContent || '').trim().substring(0, 60),
            delay: 1000,
            x: e.clientX,
            y: e.clientY
        };
        if (conditionFlowState === 'match') {
            branchMatchSteps.push(branchStep);
            showBannerToast(`Match Step #${branchMatchSteps.length} recorded`);
        } else {
            branchNoMatchSteps.push(branchStep);
            showBannerToast(`No-Match Step #${branchNoMatchSteps.length} recorded`);
        }
        return;
    }

    // --- CASE 1: Dropdown Option Box Clicked ---
    if (isOptionBox(el)) {
        const optionText = (el.textContent || '').trim();
        const optionValue = el.getAttribute('data-value') || el.getAttribute('value') || optionText;
        const step = {
            action: 'selectOption',
            isOption: true,
            optionText: optionText,
            value: optionValue,
            selector: getCSSSelector(el),
            xpath: getXPath(el),
            tagName: el.tagName || '',
            elementText: optionText.substring(0, 60),
            delay: 1000,
            x: e.clientX,
            y: e.clientY
        };
        recordedSteps.push(step);
        saveSteps();
        showBannerToast(`Option: "${optionText.substring(0, 25)}"`);
        return;
    }

    // --- CASE 2: Native <select> Element Clicked ---
    if (el.tagName && el.tagName.toLowerCase() === 'select') {
        // Will be handled cleanly on change
        return;
    }

    // --- CASE 3: Text Input / Textarea Field Clicked ---
    if (isTextInputField(el)) {
        // If clicking on the exact same active field, don't create a duplicate step
        if (lastActiveFieldStepIndex !== null && recordedSteps[lastActiveFieldStepIndex]) {
            const prev = recordedSteps[lastActiveFieldStepIndex];
            const currentSel = getCSSSelector(el);
            if (prev.selector === currentSel || (el.id && prev.idAttr === el.id) || (el.name && prev.nameAttr === el.name)) {
                showFieldDesignationPill(el, lastActiveFieldStepIndex);
                return;
            }
        }

        const step = {
            action: 'fillStatic',
            selector: getCSSSelector(el),
            xpath: getXPath(el),
            tagName: el.tagName || '',
            fieldType: el.type || el.tagName.toLowerCase(),
            nameAttr: el.name || undefined,
            idAttr: el.id || undefined,
            placeholder: el.placeholder || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            value: el.value || el.textContent || '',
            delay: 1000,
            x: e.clientX,
            y: e.clientY
        };
        recordedSteps.push(step);
        lastActiveFieldStepIndex = recordedSteps.length - 1;
        saveSteps();

        showFieldDesignationPill(el, lastActiveFieldStepIndex);
        showBannerToast(`Field: <${el.tagName.toLowerCase()}>`);
        return;
    }

    // --- CASE 4: Standard Element Click (Buttons, Links, Autofill popups, Icons, Divs) ---
    const step = {
        action: 'smartClick',
        selector: getCSSSelector(el),
        xpath: getXPath(el),
        tagName: el.tagName || '',
        elementText: (el.textContent || '').trim().substring(0, 60),
        nameAttr: el.name || undefined,
        idAttr: el.id || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        delay: 1000,
        x: e.clientX,
        y: e.clientY
    };
    recordedSteps.push(step);
    saveSteps();

    const label = el.textContent && el.textContent.trim() ? `"${el.textContent.trim().substring(0, 20)}"` : `<${(el.tagName || 'element').toLowerCase()}>`;
    showBannerToast(`Click: ${label}`);
};

// Input handler for real-time keystroke tracking during recording
const recordInputHandler = (e) => {
    if (!recordingActive || recordingPaused) return;
    const el = getEventTarget(e);
    if (!el || isExtensionUI(el)) return;

    if (isTextInputField(el) && lastActiveFieldStepIndex !== null) {
        if (recordedSteps[lastActiveFieldStepIndex] && recordedSteps[lastActiveFieldStepIndex].action === 'fillStatic') {
            recordedSteps[lastActiveFieldStepIndex].value = el.value !== undefined ? el.value : (el.textContent || '');
            saveSteps();
        }
    }
};

// Change Handler for native <select> and form inputs
const recordChangeHandler = (e) => {
    if (!recordingActive || recordingPaused) return;
    const el = getEventTarget(e);
    if (!el || isExtensionUI(el)) return;

    if (el.tagName && el.tagName.toLowerCase() === 'select') {
        const selOption = el.selectedOptions && el.selectedOptions[0];
        const optionText = selOption ? selOption.text : el.value;
        const step = {
            action: 'selectOption',
            selector: getCSSSelector(el),
            xpath: getXPath(el),
            tagName: 'SELECT',
            value: el.value,
            optionText: optionText,
            optionIndex: el.selectedIndex,
            delay: 1000
        };
        recordedSteps.push(step);
        saveSteps();
        showBannerToast(`Select Option: "${optionText}"`);
        return;
    }

    if (isTextInputField(el) && lastActiveFieldStepIndex !== null) {
        if (recordedSteps[lastActiveFieldStepIndex] && recordedSteps[lastActiveFieldStepIndex].action === 'fillStatic') {
            recordedSteps[lastActiveFieldStepIndex].value = el.value !== undefined ? el.value : (el.textContent || '');
            saveSteps();
        }
    }
};

const recordBlurHandler = (e) => {
    if (!recordingActive || recordingPaused) return;
    const el = getEventTarget(e);
    if (!el || isExtensionUI(el)) return;

    if (isTextInputField(el) && lastActiveFieldStepIndex !== null) {
        if (recordedSteps[lastActiveFieldStepIndex] && recordedSteps[lastActiveFieldStepIndex].action === 'fillStatic') {
            recordedSteps[lastActiveFieldStepIndex].value = el.value !== undefined ? el.value : (el.textContent || '');
            saveSteps();
        }
    }
};

// ========================================================
// Area Selection Flow (Manual & Clean)
// ========================================================
const startAreaSelectionFlow = (callback) => {
    document.body.classList.add('acp-area-selecting');
    showBannerToast('📐 Click any box or drag an area to select');

    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        if (isExtensionUI(e.target)) return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.pageX, startY = e.pageY;
        const overlay = createAreaOverlay();
        overlay.classList.add('active', 'dragging');

        const onMove = (me) => {
            const x = Math.min(startX, me.pageX), y = Math.min(startY, me.pageY);
            const w = Math.abs(me.pageX - startX), h = Math.abs(me.pageY - startY);
            overlay.style.left = x + 'px';
            overlay.style.top = y + 'px';
            overlay.style.width = w + 'px';
            overlay.style.height = h + 'px';
        };

        const onUp = (ue) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('mousedown', onMouseDown, true);
            document.body.classList.remove('acp-area-selecting');
            overlay.classList.remove('dragging');

            let w = Math.abs(ue.pageX - startX);
            let h = Math.abs(ue.pageY - startY);
            let area = null;

            // If user clicked without dragging, select that exact element's bounding box!
            if (w < 5 && h < 5) {
                overlay.style.display = 'none';
                const clickedTarget = document.elementFromPoint(ue.clientX, ue.clientY);
                overlay.style.display = 'block';
                if (clickedTarget && !isExtensionUI(clickedTarget) && clickedTarget !== document.body && clickedTarget !== document.documentElement) {
                    const rect = clickedTarget.getBoundingClientRect();
                    area = {
                        x: rect.left + window.scrollX,
                        y: rect.top + window.scrollY,
                        width: Math.max(12, rect.width),
                        height: Math.max(12, rect.height)
                    };
                    overlay.style.left = area.x + 'px';
                    overlay.style.top = area.y + 'px';
                    overlay.style.width = area.width + 'px';
                    overlay.style.height = area.height + 'px';
                }
            } else {
                area = {
                    x: Math.min(startX, ue.pageX),
                    y: Math.min(startY, ue.pageY),
                    width: w,
                    height: h
                };
            }

            if (!area) {
                overlay.remove();
                return;
            }

            chrome.storage.local.set({ selectedArea: area });
            showBannerToast(`Area Selected: ${Math.round(area.width)}x${Math.round(area.height)}px`);
            setTimeout(() => overlay.remove(), 1200);

            if (typeof callback === 'function') {
                callback(area);
            }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    document.addEventListener('mousedown', onMouseDown, true);
};

// ========================================================
// Manual Condition Branch Flow Implementation
// ========================================================
const startColorConditionFlow = () => {
    startAreaSelectionFlow((area) => {
        showColorInputDialog((color) => {
            if (!color) return;

            conditionFlowType = 'color';
            conditionArea = area;
            conditionTargetValue = color;
            conditionFlowState = 'match';
            branchMatchSteps = [];
            branchNoMatchSteps = [];
            branchRecordingActive = true;

            showRecordingBanner('match');
            showBannerToast(`Record MATCH clicks for color ${color}`);
        });
    });
};

const startTextConditionFlow = () => {
    startAreaSelectionFlow((area) => {
        showTextInputDialog((text) => {
            if (!text) return;

            conditionFlowType = 'text';
            conditionArea = area;
            conditionTargetValue = text;
            conditionFlowState = 'match';
            branchMatchSteps = [];
            branchNoMatchSteps = [];
            branchRecordingActive = true;

            showRecordingBanner('match');
            showBannerToast(`Record MATCH clicks for text "${text.substring(0, 15)}"`);
        });
    });
};

const handleFinishMatchBranch = () => {
    conditionFlowState = 'nomatch';
    showRecordingBanner('nomatch');
    showBannerToast('Now record clicks for NO-MATCH branch');
};

const handleFinishConditionStep = () => {
    const condStep = {
        action: 'condition',
        conditionType: conditionFlowType,
        area: conditionArea,
        detectColor: conditionFlowType === 'color' ? conditionTargetValue : undefined,
        expectedText: conditionFlowType === 'text' ? conditionTargetValue : undefined,
        matchSteps: [...branchMatchSteps],
        noMatchSteps: [...branchNoMatchSteps],
        delay: 1000
    };
    recordedSteps.push(condStep);
    saveSteps();

    branchRecordingActive = false;
    conditionFlowState = null;
    showRecordingBanner();
    showBannerToast('✓ Condition Step saved!');
};

const handleCancelBranch = () => {
    branchRecordingActive = false;
    conditionFlowState = null;
    branchMatchSteps = [];
    branchNoMatchSteps = [];
    showRecordingBanner();
    showBannerToast('Condition recording cancelled');
};

// ========================================================
// Clean In-Page Dialogs (No blocking window.prompt / alert)
// ========================================================
const showColorInputDialog = (onConfirm) => {
    const existing = document.getElementById('acp-color-picker');
    if (existing) existing.remove();

    const picker = document.createElement('div');
    picker.id = 'acp-color-picker';
    picker.innerHTML = `
        <div class="acp-cp-header">🎨 Select Target Color for Condition</div>
        <div class="acp-cp-presets">
            <button class="acp-cp-preset active" data-color="#3b82f6" style="background:#3b82f6;"></button>
            <button class="acp-cp-preset" data-color="#10b981" style="background:#10b981;"></button>
            <button class="acp-cp-preset" data-color="#ef4444" style="background:#ef4444;"></button>
            <button class="acp-cp-preset" data-color="#f59e0b" style="background:#f59e0b;"></button>
            <button class="acp-cp-preset" data-color="#8b5cf6" style="background:#8b5cf6;"></button>
        </div>
        <div class="acp-cp-custom">
            <label for="acp-cp-color-input">Custom Hex:</label>
            <input type="color" id="acp-cp-color-input" value="#3b82f6" />
            <input type="text" id="acp-cp-hex-text" value="#3b82f6" style="width:75px; padding:4px 6px; border:1px solid rgba(255,255,255,0.2); border-radius:6px; background:rgba(0,0,0,0.3); color:#fff; font-size:12px;" />
        </div>
        <div class="acp-cp-actions">
            <button id="acp-cp-cancel" class="acp-cp-btn acp-cp-btn-secondary">Cancel</button>
            <button id="acp-cp-save" class="acp-cp-btn acp-cp-btn-primary">Set Color</button>
        </div>
    `;
    document.body.appendChild(picker);

    let selectedColor = '#3b82f6';
    const colorInput = picker.querySelector('#acp-cp-color-input');
    const hexText = picker.querySelector('#acp-cp-hex-text');

    picker.querySelectorAll('.acp-cp-preset').forEach(btn => {
        btn.onclick = () => {
            picker.querySelectorAll('.acp-cp-preset').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedColor = btn.dataset.color;
            colorInput.value = selectedColor;
            hexText.value = selectedColor;
        };
    });

    colorInput.oninput = (e) => {
        selectedColor = e.target.value;
        hexText.value = selectedColor;
    };

    hexText.oninput = (e) => {
        selectedColor = e.target.value;
        if (/^#[0-9a-fA-F]{6}$/.test(selectedColor)) {
            colorInput.value = selectedColor;
        }
    };

    picker.querySelector('#acp-cp-cancel').onclick = () => {
        picker.remove();
        onConfirm(null);
    };

    picker.querySelector('#acp-cp-save').onclick = () => {
        picker.remove();
        onConfirm(selectedColor);
    };
};

const showTextInputDialog = (onConfirm) => {
    const existing = document.getElementById('acp-text-input');
    if (existing) existing.remove();

    const dialog = document.createElement('div');
    dialog.id = 'acp-text-input';
    dialog.innerHTML = `
        <div class="acp-ti-header">📝 Enter Text Condition Target</div>
        <input type="text" id="acp-ti-val" class="acp-ti-input" placeholder="Text to search in selected area..." />
        <div class="acp-ti-actions">
            <button id="acp-ti-cancel" class="acp-cp-btn acp-cp-btn-secondary">Cancel</button>
            <button id="acp-ti-save" class="acp-cp-btn acp-cp-btn-primary">Set Text</button>
        </div>
    `;
    document.body.appendChild(dialog);

    const input = dialog.querySelector('#acp-ti-val');
    input.focus();

    dialog.querySelector('#acp-ti-cancel').onclick = () => {
        dialog.remove();
        onConfirm(null);
    };

    dialog.querySelector('#acp-ti-save').onclick = () => {
        const val = input.value.trim();
        dialog.remove();
        onConfirm(val || null);
    };
};

const createAreaOverlay = () => {
    let overlay = document.getElementById('acp-area-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'acp-area-overlay';
        overlay.style.position = 'absolute';
        overlay.style.border = '2px dashed #00bcd4';
        overlay.style.background = 'rgba(0,188,212,0.14)';
        overlay.style.zIndex = '2147483646';
        overlay.style.pointerEvents = 'none';
        overlay.style.display = 'block';
        document.body.appendChild(overlay);
    }
    return overlay;
};

const hideAreaOverlay = () => {
    const overlay = document.getElementById('acp-area-overlay');
    if (overlay) overlay.remove();
};

// ========================================================
// On-Screen UI & Floating Manual Banner (NO SHORTCUTS)
// ========================================================
const showRecordingBanner = (branch = null) => {
    if (!document.body || window !== window.top) return;

    let banner = document.getElementById('acp-recorder-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'acp-recorder-banner';
        document.body.appendChild(banner);
        makeDraggable(banner);
    }

    const stepCount = recordedSteps.length;

    let branchBadge = '';
    let branchControls = '';

    if (branch === 'match') {
        branchBadge = '<div class="acp-banner-branch match">Recording: MATCH Branch</div>';
        branchControls = `
            <button id="acp-done-match-btn" class="acp-field-pill-btn" style="background:#10b981; color:#fff; border:none; padding:6px 10px;">✓ Done Match</button>
            <button id="acp-cancel-branch-btn" class="acp-field-pill-btn" style="background:rgba(255,255,255,0.08); padding:6px 10px;">Cancel</button>
        `;
    } else if (branch === 'nomatch') {
        branchBadge = '<div class="acp-banner-branch nomatch">Recording: NO-MATCH Branch</div>';
        branchControls = `
            <button id="acp-done-cond-btn" class="acp-field-pill-btn" style="background:#10b981; color:#fff; border:none; padding:6px 10px;">✓ Save Condition</button>
            <button id="acp-cancel-branch-btn" class="acp-field-pill-btn" style="background:rgba(255,255,255,0.08); padding:6px 10px;">Cancel</button>
        `;
    }

    const standardControls = `
        <button id="acp-pause-btn" class="acp-field-pill-btn" style="padding:6px 10px;">${recordingPaused ? 'Resume' : 'Pause'}</button>
        <button id="acp-stop-btn" title="Save and finish recording sequence">Finish</button>
    `;

    const toolControls = !branch ? `
        <div style="display:flex; gap:4px; margin-top:4px;">
            <button id="acp-tool-color-btn" class="acp-field-pill-btn" style="font-size:10px; color:#80deea;">🎨 Color Cond</button>
            <button id="acp-tool-text-btn" class="acp-field-pill-btn" style="font-size:10px; color:#c4b5fd;">📝 Text Cond</button>
            <button id="acp-tool-area-btn" class="acp-field-pill-btn" style="font-size:10px; color:#fde047;">📐 Area</button>
        </div>
    ` : '';

    banner.innerHTML = `
        <div class="acp-banner-drag-handle" style="cursor:grab; display:flex; align-items:center; padding-right:4px;" title="Drag to reposition banner">
            <svg width="12" height="18" viewBox="0 0 12 18" fill="#666"><circle cx="4" cy="4" r="1.5"/><circle cx="8" cy="4" r="1.5"/><circle cx="4" cy="9" r="1.5"/><circle cx="8" cy="9" r="1.5"/><circle cx="4" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>
        </div>
        <div class="acp-banner-icon">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ff4757">
                <circle cx="12" cy="12" r="8"></circle>
            </svg>
        </div>
        <div class="acp-banner-text">
            <div style="display:flex; align-items:center; gap:6px;">
                <strong>Recording Active</strong>
                <span id="acp-banner-count" class="acp-step-badge">${stepCount} Steps</span>
            </div>
            <span style="font-size:11px; color:#94a3b8;">Manual Recording Mode</span>
            ${branchBadge}
            ${toolControls}
            <div id="acp-banner-toast" class="acp-banner-toast" style="display:none;"></div>
        </div>
        <div class="acp-banner-controls">
            ${branchControls ? branchControls : standardControls}
        </div>
    `;

    // Bind Manual Buttons
    if (branch === 'match') {
        const doneMatchBtn = document.getElementById('acp-done-match-btn');
        if (doneMatchBtn) doneMatchBtn.onclick = (e) => { e.stopPropagation(); handleFinishMatchBranch(); };
        const cancelBranchBtn = document.getElementById('acp-cancel-branch-btn');
        if (cancelBranchBtn) cancelBranchBtn.onclick = (e) => { e.stopPropagation(); handleCancelBranch(); };
    } else if (branch === 'nomatch') {
        const doneCondBtn = document.getElementById('acp-done-cond-btn');
        if (doneCondBtn) doneCondBtn.onclick = (e) => { e.stopPropagation(); handleFinishConditionStep(); };
        const cancelBranchBtn = document.getElementById('acp-cancel-branch-btn');
        if (cancelBranchBtn) cancelBranchBtn.onclick = (e) => { e.stopPropagation(); handleCancelBranch(); };
    } else {
        const stopBtn = document.getElementById('acp-stop-btn');
        if (stopBtn) {
            stopBtn.onclick = (e) => {
                e.stopPropagation();
                chrome.storage.local.set({ isRecording: false });
            };
        }

        const pauseBtn = document.getElementById('acp-pause-btn');
        if (pauseBtn) {
            pauseBtn.onclick = (e) => {
                e.stopPropagation();
                recordingPaused = !recordingPaused;
                pauseBtn.textContent = recordingPaused ? 'Resume' : 'Pause';
                showBannerToast(recordingPaused ? '⏸ Recording Paused' : '▶ Recording Resumed');
            };
        }

        const colorToolBtn = document.getElementById('acp-tool-color-btn');
        if (colorToolBtn) {
            colorToolBtn.onclick = (e) => { e.stopPropagation(); startColorConditionFlow(); };
        }

        const textToolBtn = document.getElementById('acp-tool-text-btn');
        if (textToolBtn) {
            textToolBtn.onclick = (e) => { e.stopPropagation(); startTextConditionFlow(); };
        }

        const areaToolBtn = document.getElementById('acp-tool-area-btn');
        if (areaToolBtn) {
            areaToolBtn.onclick = (e) => { e.stopPropagation(); startAreaSelectionFlow(); };
        }
    }
};

const makeDraggable = (el) => {
    let isDragging = false;
    let startX, startY, origX, origY;

    el.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        el.style.right = 'auto';
        el.style.left = `${origX}px`;
        el.style.top = `${origY}px`;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        el.style.left = `${Math.max(10, Math.min(window.innerWidth - el.offsetWidth - 10, origX + dx))}px`;
        el.style.top = `${Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, origY + dy))}px`;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });
};

const hideRecordingBanner = () => {
    const banner = document.getElementById('acp-recorder-banner');
    if (banner) banner.remove();
};

const updateBannerStepCount = () => {
    const countEl = document.getElementById('acp-banner-count');
    if (countEl) {
        countEl.textContent = `${recordedSteps.length} Steps`;
    }
};

const showBannerToast = (msg) => {
    const toast = document.getElementById('acp-banner-toast');
    if (toast) {
        toast.textContent = msg;
        toast.style.display = 'inline-block';
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => {
            if (toast) toast.style.display = 'none';
        }, 3000);
    }
    updateBannerStepCount();
};

// Floating Field Designation Pill
const showFieldDesignationPill = (el, stepIndex) => {
    removeFieldPill();
    if (!el || window !== window.top) return;

    const rect = el.getBoundingClientRect();
    const pill = document.createElement('div');
    pill.className = 'acp-field-pill';
    pill.id = 'acp-active-field-pill';
    pill.style.left = `${Math.max(10, rect.left + window.scrollX)}px`;
    pill.style.top = `${Math.max(10, rect.top + window.scrollY - 36)}px`;

    pill.innerHTML = `
        <span style="font-size:10px; color:#c4b5fd;">Field:</span>
        <button id="acp-set-para-btn" class="acp-field-pill-btn para-btn" title="Set this field to fill with next paragraph from TXT file on each rotation">
            📄 Set as Para Box (TXT)
        </button>
        <button id="acp-set-paste-btn" class="acp-field-pill-btn" style="color:#fbbf24; border-color:rgba(245,158,11,0.3);" title="Set this field to paste system clipboard content">
            📋 Paste Clipboard
        </button>
        <button id="acp-dismiss-pill-btn" class="acp-field-pill-btn" title="Keep as regular static text">
            ✓ Done
        </button>
    `;

    document.body.appendChild(pill);
    lastFieldPillEl = pill;

    document.getElementById('acp-set-para-btn').onclick = (e) => {
        e.stopPropagation();
        if (recordedSteps[stepIndex]) {
            recordedSteps[stepIndex].action = 'fillParagraph';
            saveSteps();
            showBannerToast('⭐ Designated as Dynamic Paragraph Field!');
        }
        removeFieldPill();
    };

    document.getElementById('acp-set-paste-btn').onclick = (e) => {
        e.stopPropagation();
        if (recordedSteps[stepIndex]) {
            recordedSteps[stepIndex].action = 'pasteClipboard';
            saveSteps();
            showBannerToast('⭐ Designated as Clipboard Paste Field!');
        }
        removeFieldPill();
    };

    document.getElementById('acp-dismiss-pill-btn').onclick = (e) => {
        e.stopPropagation();
        removeFieldPill();
    };

    setTimeout(() => {
        if (lastFieldPillEl === pill) removeFieldPill();
    }, 8000);
};

const removeFieldPill = () => {
    if (lastFieldPillEl) {
        lastFieldPillEl.remove();
        lastFieldPillEl = null;
    }
    const existing = document.getElementById('acp-active-field-pill');
    if (existing) existing.remove();
};

// Visual Hover Highlighting
let highlightEl = null;
const highlightOnHover = (e) => {
    const target = getEventTarget(e);
    if (!target) return;
    if (highlightEl && highlightEl !== target) {
        highlightEl.classList.remove('acp-element-highlight');
    }
    if (target !== document.body && target !== document.documentElement && !isExtensionUI(target)) {
        target.classList.add('acp-element-highlight');
        highlightEl = target;
    }
};

const removeHighlight = () => {
    if (highlightEl) {
        highlightEl.classList.remove('acp-element-highlight');
        highlightEl = null;
    }
    document.querySelectorAll('.acp-element-highlight').forEach(el => el.classList.remove('acp-element-highlight'));
};

const createClickIndicator = (x, y, type = 'smart') => {
    const indicator = document.createElement('div');
    indicator.className = `acp-click-indicator ${type}`;
    indicator.style.left = `${x}px`;
    indicator.style.top = `${y}px`;
    document.body.appendChild(indicator);
    setTimeout(() => {
        indicator.style.opacity = '0';
        setTimeout(() => indicator.remove(), 400);
    }, 300);
};

// ========================================================
// Playback Engine & Form Filling Implementation
// ========================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'runSteps') {
        executeSteps(msg.steps, msg.loop);
    } else if (msg.action === 'stop') {
        stopExecution = true;
    } else if (msg.action === 'startRecordingSession') {
        startRecordingLocally();
    } else if (msg.action === 'stopRecordingSession') {
        stopRecordingLocally();
    } else if (msg.action === 'startAreaSelection') {
        startAreaSelectionFlow();
    } else if (msg.action === 'startColorCondition') {
        startColorConditionFlow();
    } else if (msg.action === 'startTextCondition') {
        startTextConditionFlow();
    } else if (msg.action === 'testSingleStep') {
        executeStep(msg.step).then(() => {
            sendResponse({ success: true });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }
});

// React & Framework-compatible input value setter
const setNativeValue = (element, value) => {
    const proto = Object.getPrototypeOf(element);
    const valueDescriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');

    const tracker = element._valueTracker;
    if (tracker) {
        tracker.setValue(value);
    }

    if (valueDescriptor && valueDescriptor.set) {
        valueDescriptor.set.call(element, value);
    } else {
        element.value = value;
    }
};

// React & Framework-compatible checkbox setter
const setNativeChecked = (element, checked) => {
    const proto = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'checked')
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');

    const tracker = element._valueTracker;
    if (tracker) {
        tracker.setValue(!checked);
    }

    if (descriptor && descriptor.set) {
        descriptor.set.call(element, checked);
    } else {
        element.checked = checked;
    }
};

const isElementVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // Allow opacity:0 for checkboxes & radio buttons since custom styled frameworks often visually conceal them
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        return true;
    }
    return style.opacity !== '0';
};

// Robust multi-strategy element search piercing Shadow Roots
const findElementSmart = async (step) => {
    if (step.selector) {
        try {
            const el = querySelectorDeep(step.selector);
            if (el && isElementVisible(el)) return el;
        } catch (e) {}
    }

    if (step.inputSelector) {
        try {
            const el = querySelectorDeep(step.inputSelector);
            if (el && isElementVisible(el)) return el;
        } catch (e) {}
    }

    if (step.idAttr) {
        try {
            const el = document.getElementById(step.idAttr) || querySelectorDeep(`#${CSS.escape(step.idAttr)}`);
            if (el && isElementVisible(el)) return el;
        } catch (e) {}
    }

    if (step.nameAttr) {
        try {
            const el = querySelectorDeep(`[name="${CSS.escape(step.nameAttr)}"]`);
            if (el && isElementVisible(el)) return el;
        } catch (e) {}
    }

    if (step.placeholder) {
        try {
            const el = querySelectorDeep(`[placeholder="${CSS.escape(step.placeholder)}"]`);
            if (el && isElementVisible(el)) return el;
        } catch (e) {}
    }

    if (step.ariaLabel) {
        try {
            const el = querySelectorDeep(`[aria-label="${CSS.escape(step.ariaLabel)}"]`);
            if (el && isElementVisible(el)) return el;
        } catch (e) {}
    }

    if (step.xpath) {
        try {
            const result = document.evaluate(step.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result && result.singleNodeValue && isElementVisible(result.singleNodeValue)) {
                return result.singleNodeValue;
            }
        } catch (e) {}
    }

    if (step.isOption || step.action === 'selectOption') {
        const textToFind = (step.optionText || step.value || step.elementText || '').trim().toLowerCase();
        if (textToFind) {
            const candidates = document.querySelectorAll('[role="option"], [role="menuitem"], .dropdown-item, .option, li, div, button, span');
            for (const cand of candidates) {
                if (cand.textContent && cand.textContent.trim().toLowerCase() === textToFind && isElementVisible(cand)) {
                    return cand;
                }
            }
            for (const cand of candidates) {
                if (cand.textContent && cand.textContent.trim().toLowerCase().includes(textToFind) && isElementVisible(cand)) {
                    return cand;
                }
            }
        }
    }

    if (step.elementText && step.tagName) {
        const textToFind = step.elementText.trim().toLowerCase();
        const candidates = document.querySelectorAll(step.tagName);
        for (const cand of candidates) {
            if (cand.textContent && cand.textContent.trim().toLowerCase() === textToFind && isElementVisible(cand)) {
                return cand;
            }
        }
        for (const cand of candidates) {
            if (cand.textContent && cand.textContent.trim().toLowerCase().includes(textToFind) && isElementVisible(cand)) {
                return cand;
            }
        }
    }

    if (typeof step.x === 'number' && typeof step.y === 'number') {
        const vx = step.clientX !== undefined ? step.clientX : step.x;
        const vy = step.clientY !== undefined ? step.clientY : step.y;
        const el = document.elementFromPoint(vx, vy);
        if (el) return el;
    }

    return null;
};

// Waits for element to appear
const waitForElement = async (step, timeoutMs = 2500) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        const el = await findElementSmart(step);
        if (el) return el;
        await new Promise(r => setTimeout(r, 80));
    }
    return findElementSmart(step);
};

// Fill a form field
const fillFormField = (el, text) => {
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    try { el.focus(); } catch (e) {}

    const tag = el.tagName.toLowerCase();

    if (tag === 'select') {
        const option = Array.from(el.options).find(opt =>
            opt.textContent.trim().toLowerCase() === text.trim().toLowerCase() ||
            opt.value.trim().toLowerCase() === text.trim().toLowerCase() ||
            opt.textContent.toLowerCase().includes(text.trim().toLowerCase())
        );
        if (option) {
            el.selectedIndex = option.index;
            setNativeValue(el, option.value);
        } else if (el.options.length > 0) {
            el.selectedIndex = 0;
            setNativeValue(el, el.options[0].value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tag === 'textarea' || tag === 'input') {
        setNativeValue(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
        try {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
        } catch (e) {
            el.innerText = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    el.dispatchEvent(new Event('blur', { bubbles: true }));
};

// Select a dropdown option
const selectDropdownOption = async (step) => {
    const el = await waitForElement(step);
    if (!el) return false;

    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}

    if (el.tagName && el.tagName.toLowerCase() === 'select') {
        const option = Array.from(el.options).find(opt =>
            (step.value && opt.value === step.value) ||
            (step.optionText && opt.text.trim().toLowerCase() === step.optionText.trim().toLowerCase()) ||
            (step.optionIndex !== undefined && opt.index === step.optionIndex)
        );
        if (option) {
            el.selectedIndex = option.index;
            setNativeValue(el, option.value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
    }

    dispatchClickEvents(el);
    return true;
};

// Dispatch synthetic events AND trigger native .click()
const dispatchClickEvents = (el) => {
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    try { el.focus(); } catch (e) {}

    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const mouseOpts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: cx,
        clientY: cy,
        pointerId: 1,
        isPrimary: true
    };

    try { el.dispatchEvent(new PointerEvent('pointerdown', mouseOpts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', mouseOpts)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', mouseOpts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', mouseOpts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', mouseOpts)); } catch (e) {}

    // CRITICAL: Call native .click() so checkboxes, radios, links and forms actually toggle/submit!
    if (typeof el.click === 'function') {
        try {
            el.click();
        } catch (e) {}
    }
};

// Condition Scanning Helpers
const scanAreaForColor = (area, targetColor) => {
    if (!area || !targetColor) return false;
    const target = targetColor.trim().toLowerCase();
    const all = document.querySelectorAll('*');
    for (const el of all) {
        if (!isElementVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.left < area.x + area.width && r.right > area.x &&
            r.top < area.y + area.height && r.bottom > area.y) {
            const cs = window.getComputedStyle(el);
            if (colorMatches(cs.backgroundColor, target) || colorMatches(cs.color, target)) {
                return true;
            }
        }
    }
    return false;
};

const colorMatches = (rgbStr, targetHex) => {
    if (!rgbStr || !targetHex) return false;
    const match = rgbStr.match(/\d+/g);
    if (!match || match.length < 3) return false;
    const r = parseInt(match[0]), g = parseInt(match[1]), b = parseInt(match[2]);
    const hex = "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toLowerCase();
    return hex === targetHex.toLowerCase();
};

const scanAreaForText = (area, expectedText) => {
    if (!area || !expectedText) return false;
    const target = expectedText.trim().toLowerCase();
    const all = document.querySelectorAll('*');
    for (const el of all) {
        if (!isElementVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.left < area.x + area.width && r.right > area.x &&
            r.top < area.y + area.height && r.bottom > area.y) {
            if (el.textContent && el.textContent.toLowerCase().includes(target)) {
                return true;
            }
        }
    }
    return false;
};

// Execute single step
const executeStep = async (step) => {
    if (stopExecution) return;

    // --- Dynamic Paragraph Fill (from TXT) ---
    if (step.action === 'fillParagraph' || step.action === 'fillField') {
        const data = await storageGet('paragraphs');
        const paragraphs = data.paragraphs || [];

        if (paragraphs.length === 0) {
            alert('⚠️ All paragraphs in your library have been used! The sequence will now stop.');
            stopExecution = true;
            return;
        }

        const currentPara = paragraphs.shift();
        await storageSet({ paragraphs });

        const el = await waitForElement(step);
        if (el) {
            fillFormField(el, currentPara);
            createClickIndicator(el.getBoundingClientRect().left, el.getBoundingClientRect().top, 'fill');
        }
        return;
    }

    // --- Clipboard Pasting Step ---
    if (step.action === 'pasteClipboard') {
        const el = await waitForElement(step);
        if (el) {
            let clipboardText = '';
            try {
                clipboardText = await navigator.clipboard.readText();
            } catch (e) {
                el.focus();
                try {
                    clipboardText = await navigator.clipboard.readText();
                } catch (err) {}
            }
            if (clipboardText) {
                fillFormField(el, clipboardText);
                createClickIndicator(el.getBoundingClientRect().left, el.getBoundingClientRect().top, 'fill');
            }
        }
        return;
    }

    // --- Static Text Field Fill ---
    if (step.action === 'fillStatic') {
        const el = await waitForElement(step);
        if (el) {
            fillFormField(el, step.value || '');
            createClickIndicator(el.getBoundingClientRect().left, el.getBoundingClientRect().top, 'smart');
        }
        return;
    }

    // --- Dropdown Option Selection ---
    if (step.action === 'selectOption') {
        await selectDropdownOption(step);
        return;
    }

    // --- Condition Branch Step (Color or Text) ---
    if (step.action === 'condition') {
        let matched = false;
        if (step.conditionType === 'color') {
            matched = scanAreaForColor(step.area, step.detectColor);
        } else if (step.conditionType === 'text') {
            matched = scanAreaForText(step.area, step.expectedText);
        }
        const branchSteps = matched ? (step.matchSteps || []) : (step.noMatchSteps || []);
        for (const subStep of branchSteps) {
            if (stopExecution) break;
            await new Promise(r => setTimeout(r, subStep.delay || 500));
            await executeStep(subStep);
        }
        return;
    }

    // --- Smart Click / Checkbox / Selection Box / Coordinate Click ---
    const el = await waitForElement(step);
    if (el) {
        dispatchClickEvents(el);

        // Special handling for Checkbox & Radio controls to guarantee state toggle in modern frameworks
        const cb = getAssociatedCheckbox(el);
        if (cb && cb.tagName === 'INPUT' && (cb.type === 'checkbox' || cb.type === 'radio')) {
            if (cb !== el && typeof cb.click === 'function') {
                try { cb.click(); } catch (e) {}
            }
            if (step.isCheckbox && typeof step.targetChecked === 'boolean' && cb.checked !== step.targetChecked) {
                setNativeChecked(cb, step.targetChecked);
                cb.dispatchEvent(new Event('input', { bubbles: true }));
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else if (el.getAttribute && el.getAttribute('role') === 'checkbox') {
            const curAria = el.getAttribute('aria-checked');
            const nextAria = (curAria === 'true') ? 'false' : 'true';
            el.setAttribute('aria-checked', nextAria);
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    } else if (typeof step.x === 'number' && typeof step.y === 'number') {
        const vx = step.clientX !== undefined ? step.clientX : step.x;
        const vy = step.clientY !== undefined ? step.clientY : step.y;
        const target = document.elementFromPoint(vx, vy);
        if (target) dispatchClickEvents(target);
    }
};

// Master Sequence Runner
const executeSteps = async (steps, loop) => {
    stopExecution = false;
    const loopConfig = loop || { enabled: false, infinite: false, count: 1, delay: 2000 };
    const loopCount = loopConfig.enabled ? (loopConfig.infinite ? Infinity : (loopConfig.count || 1)) : 1;
    const rotationDelay = loopConfig.delay || 2000;

    let currentLoop = 0;

    while (currentLoop < loopCount && !stopExecution) {
        currentLoop++;

        for (let i = 0; i < steps.length; i++) {
            if (stopExecution) break;

            contentSend({
                action: 'progressUpdate',
                data: {
                    stepIndex: i,
                    totalSteps: steps.length,
                    currentLoop: currentLoop,
                    totalLoops: loopCount,
                    action: steps[i].action
                }
            });

            await new Promise(r => setTimeout(r, steps[i].delay || 1000));
            if (stopExecution) break;

            await executeStep(steps[i]);
        }

        if (currentLoop < loopCount && !stopExecution) {
            contentSend({
                action: 'progressUpdate',
                data: {
                    stepIndex: steps.length - 1,
                    totalSteps: steps.length,
                    currentLoop: currentLoop,
                    totalLoops: loopCount,
                    isBetweenRotations: true
                }
            });
            await new Promise(r => setTimeout(r, rotationDelay));
        }
    }

    contentSend({ action: 'executionFinished' });
};
