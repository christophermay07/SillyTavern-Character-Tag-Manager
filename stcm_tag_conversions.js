// ============================================================================
// stcm_tag_conversions.js
// ----------------------------------------------------------------------------
// Tag conversion rules: rewrite tags that arrive with imported cards into the
// user's own tag scheme, one-to-one or one-to-many, e.g.
//     drow -> race:elf, phys:dark-skin
//
// * Rules are stored by NAME in extensionSettings.stcm.tagConversions as
//   [{ from: 'drow', to: ['race:elf', 'phys:dark-skin'] }, ...]. They never
//   hold tag IDs: Convert deletes source tags, so the next card import
//   re-creates them with fresh UUIDs, and every run re-resolves names.
// * Name matching uses ST's equalsIgnoreCaseAndAccents, same as ST's getTag().
// * A run has three phases: resolve (no mutation) → preview → apply.
//   Everything is resolved against the original state first, so rules never
//   cascade (A -> B, B -> C gives A-tagged characters B, not C).
// * Assumes ST's tag import setting is "All" (see README).
//
// Public API: openTagConversionsEditor()
// ============================================================================

/* eslint-disable import/no-cycle */ // circular with index.js is OK (ES modules)

import { tags, tag_map, tag_import_setting } from '../../../tags.js';
import { power_user } from '../../../power-user.js';
import { equalsIgnoreCaseAndAccents, uuidv4 } from '../../../utils.js';
import { DEFAULT_FILTER_STATE } from '../../../filters.js';
import { getContext } from '../../../extensions.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { escapeHtml, getNotes, saveNotes, addTagMapBackup } from './utils.js';
import { callSaveandReload } from './index.js';
import { renderTagSection, populateAssignTagSelect } from './stcm_tags_ui.js';
import { renderCharacterList } from './stcm_characters.js';

const PREVIEW_AND_CONVERT = 2; // custom popup result for the editor's third button

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------
function getStcmSettings() {
    const ctx = getContext();
    if (!ctx.extensionSettings.stcm) ctx.extensionSettings.stcm = {};
    return ctx.extensionSettings.stcm;
}

function getRules() {
    const rules = getStcmSettings().tagConversions;
    return Array.isArray(rules) ? rules : [];
}

function saveRules(rules) {
    getStcmSettings().tagConversions = rules;
    getContext().saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// text format:  source -> target1, target2   (# comments, blank lines ok)
// ---------------------------------------------------------------------------
function rulesToText(rules) {
    return rules.map(r => `${r.from} -> ${r.to.join(', ')}`).join('\n');
}

function parseRules(text) {
    const rules = [];
    const errors = [];
    const seen = []; // { from, line }

    text.split('\n').forEach((raw, i) => {
        const lineNo = i + 1;
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;

        const parts = line.split('->');
        if (parts.length !== 2) {
            errors.push(`Line ${lineNo}: must contain exactly one "->".`);
            return;
        }
        const from = parts[0].trim();
        if (!from) {
            errors.push(`Line ${lineNo}: missing source tag before "->".`);
            return;
        }

        // drop empty targets, the source itself, and duplicates
        const to = [];
        parts[1].split(',').map(s => s.trim()).filter(Boolean).forEach(name => {
            if (equalsIgnoreCaseAndAccents(name, from)) return;
            if (to.some(t => equalsIgnoreCaseAndAccents(t, name))) return;
            to.push(name);
        });
        if (!to.length) {
            errors.push(`Line ${lineNo}: needs at least one target tag (other than the source).`);
            return;
        }

        const dup = seen.find(s => equalsIgnoreCaseAndAccents(s.from, from));
        if (dup) {
            errors.push(`Line ${lineNo}: duplicate source "${from}" (also on line ${dup.line}).`);
            return;
        }
        seen.push({ from, line: lineNo });
        rules.push({ from, to });
    });

    return { rules, errors };
}

// ---------------------------------------------------------------------------
// rule editor
// ---------------------------------------------------------------------------
export async function openTagConversionsEditor() {
    const root = document.createElement('div');
    root.style.textAlign = 'left';
    root.innerHTML = `
        <h3>Tag Conversions</h3>
        <p><small>
            One rule per line: <code>source -> target1, target2</code>.
            Lines starting with <code>#</code> are comments. Names match ignoring case and accents.
            <b>Convert</b> replaces each source tag with its targets on every character/group, creates missing
            targets, and <b>deletes the source tag</b>. Unmapped tags are untouched.
            Copy/paste this text to back up or share your rules.
        </small></p>
        <textarea class="text_pole stcm_conversion_rules" rows="16" spellcheck="false"
            placeholder="malepov -> povg:male&#10;drow -> race:elf, phys:dark-skin"
            style="width:100%;font-family:monospace;"></textarea>
        <div class="stcm_conversion_errors" style="color:#e57373;white-space:pre-line;"></div>
    `;
    const textarea = root.querySelector('textarea');
    const errorsDiv = root.querySelector('.stcm_conversion_errors');
    textarea.value = rulesToText(getRules());

    let parsed = null;
    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
        allowVerticalScrolling: true,
        customButtons: [{ text: 'Preview & Convert', result: PREVIEW_AND_CONVERT, icon: 'fa-right-left' }],
        // validate before closing; keep the popup open (and the text) on errors
        onClosing: (popup) => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE && popup.result !== PREVIEW_AND_CONVERT) return true;
            parsed = parseRules(textarea.value);
            if (parsed.errors.length) {
                errorsDiv.textContent = `Fix these lines before saving:\n${parsed.errors.join('\n')}`;
                return false;
            }
            return true;
        },
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE && result !== PREVIEW_AND_CONVERT) return;
    saveRules(parsed.rules);
    toastr.success(`Saved ${parsed.rules.length} conversion rule${parsed.rules.length === 1 ? '' : 's'}.`);

    if (result === PREVIEW_AND_CONVERT) await runConversion(parsed.rules);
}

// ---------------------------------------------------------------------------
// Phase A: resolve (no mutation)
// ---------------------------------------------------------------------------
function countEntitiesWith(tagId) {
    return Object.values(tag_map).filter(arr => Array.isArray(arr) && arr.includes(tagId)).length;
}

function resolveConversion(rules) {
    const pendingByName = new Map(); // lowercased name → pending create entry, shared across rules
    const applied = [];
    const skipped = [];
    const duplicateTargets = new Map(); // chosen tag id → all matching tags

    for (const rule of rules) {
        // ALL tags with the source name, not just the first
        const sources = tags.filter(t => equalsIgnoreCaseAndAccents(t.name, rule.from));
        if (!sources.length) { skipped.push(rule); continue; }

        const targets = rule.to.map(name => {
            const matches = tags.filter(t => equalsIgnoreCaseAndAccents(t.name, name));
            if (matches.length) {
                // first in array order, the same tag ST's getTag() returns
                const tag = matches[0];
                if (matches.length > 1) duplicateTargets.set(tag.id, matches);
                return { name: tag.name, id: tag.id, isNew: false };
            }
            const key = [...pendingByName.keys()].find(k => equalsIgnoreCaseAndAccents(k, name));
            if (key) return pendingByName.get(key);
            const pending = { name, id: uuidv4(), isNew: true };
            pendingByName.set(name, pending);
            return pending;
        });

        const sourceIds = new Set(sources.map(t => t.id));
        const entityKeys = Object.keys(tag_map).filter(k =>
            Array.isArray(tag_map[k]) && tag_map[k].some(id => sourceIds.has(id)));

        applied.push({ rule, sources, targets, entityKeys });
    }

    // A tag that is one rule's source and another rule's target is converted
    // on the characters that had it, but the tag itself is kept so the other
    // rule's targets stay valid (no cascade).
    const targetIds = new Set(applied.flatMap(a => a.targets.map(t => t.id)));
    const removeTags = applied.flatMap(a => a.sources).filter(t => !targetIds.has(t.id));
    const chained = applied.filter(a => a.sources.some(t => targetIds.has(t.id)));

    return {
        applied,
        skipped,
        newTargets: [...pendingByName.values()],
        removeTags,
        chained,
        duplicateTargets: [...duplicateTargets.entries()],
        folderSources: applied.flatMap(a => a.sources)
            .filter(t => ['OPEN', 'CLOSED'].includes(String(t.folder_type || '').toUpperCase())),
        entityCount: new Set(applied.flatMap(a => a.entityKeys)).size,
    };
}

// ---------------------------------------------------------------------------
// Phase B: preview
// ---------------------------------------------------------------------------
async function showPreview(plan) {
    const e = escapeHtml;
    const warnings = [];

    if (plan.duplicateTargets.length) {
        const items = plan.duplicateTargets.map(([chosenId, matches]) => {
            const rows = matches.map(t => {
                const date = t.create_date ? new Date(t.create_date).toLocaleString() : 'unknown date';
                const mark = t.id === chosenId ? ' <b>← Convert will use this one</b>' : ' (left untouched)';
                return `<li><code>${e(t.id)}</code>: ${countEntitiesWith(t.id)} characters, created ${e(date)}${mark}</li>`;
            }).join('');
            return `<li><b>${e(matches[0].name)}</b> matches ${matches.length} tags:<ul>${rows}</ul></li>`;
        }).join('');
        warnings.push(`
            <div style="border:2px solid #e57373;padding:6px 10px;margin-bottom:8px;border-radius:6px;">
                <b style="color:#e57373;">Duplicate target tags</b>
                <p><small>Several existing tags share a target's name. Convert uses the first one (the same one
                SillyTavern uses when importing) and does not merge or delete the others. This usually points to a
                bigger data problem worth cleaning up with Merge Tags.</small></p>
                <ul style="margin-left:1.2em">${items}</ul>
            </div>`);
    }

    if (power_user.tag_import_setting !== tag_import_setting.ALL) {
        warnings.push(`<p style="color:#e57373;"><b>"Import Card Tags" is not set to "All".</b> Convert deletes
            source tags. With "Existing", future card imports will silently drop those tags, so these rules will
            never see them again. With "Ask", they will be offered as new tags on every import. Set
            User Settings → Import Card Tags to "All" for this workflow.</p>`);
    }
    if (plan.chained.length) {
        const names = plan.chained.map(a => `<code>${e(a.rule.from)}</code>`).join(', ');
        warnings.push(`<p><b>Chained rules:</b> ${names} ${plan.chained.length === 1 ? 'is' : 'are'} also another
            rule's target. Rules don't cascade: characters that had it are converted, characters that receive it
            from another rule keep it, and the tag itself is not deleted.</p>`);
    }
    if (plan.folderSources.length) {
        const names = plan.folderSources.map(t => `<code>${e(t.name)}</code>`).join(', ');
        warnings.push(`<p><b>Folder tags:</b> ${names} ${plan.folderSources.length === 1 ? 'is a' : 'are'} tag
            folder${plan.folderSources.length === 1 ? '' : 's'}. Deleting it removes that folder.</p>`);
    }
    const multi = plan.applied.filter(a => a.sources.length > 1);
    if (multi.length) {
        const names = multi.map(a => `<code>${e(a.rule.from)}</code> ×${a.sources.length}`).join(', ');
        warnings.push(`<p><small>Several tags share a source name: ${names}. All of them are converted and deleted.</small></p>`);
    }

    const ruleRows = plan.applied.map(a => {
        const targets = a.targets.map(t => `${e(t.name)} <small>(${t.isNew ? 'new' : 'existing'})</small>`).join(', ');
        return `<li><code>${e(a.rule.from)}</code> → ${targets} <small>[${a.entityKeys.length} characters]</small></li>`;
    }).join('');

    const html = document.createElement('div');
    html.style.textAlign = 'left';
    html.innerHTML = `
        <h3>Tag Conversion Preview</h3>
        ${warnings.join('')}
        <p>${plan.applied.length} rule${plan.applied.length === 1 ? '' : 's'} apply,
           ${plan.skipped.length} skipped (no matching source tag).
           ${plan.newTargets.length} new tag${plan.newTargets.length === 1 ? '' : 's'} will be created,
           ${plan.removeTags.length} source tag${plan.removeTags.length === 1 ? '' : 's'} deleted,
           ${plan.entityCount} character${plan.entityCount === 1 ? '' : 's'}/group${plan.entityCount === 1 ? '' : 's'} affected.</p>
        <ul style="margin-left:1.2em">${ruleRows}</ul>
        <p><small>A "pre-convert" backup is saved first, and you can Undo right after.</small></p>
    `;
    const res = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Convert',
        cancelButton: 'Cancel',
        wide: true,
        allowVerticalScrolling: true,
    });
    return res === POPUP_RESULT.AFFIRMATIVE;
}

// ---------------------------------------------------------------------------
// Phase C: apply
// ---------------------------------------------------------------------------
function applyConversion(plan) {
    addTagMapBackup('pre-convert');

    const removeIds = new Set(plan.removeTags.map(t => t.id));
    const notes = getNotes();
    const undo = {
        createdIds: plan.newTargets.map(t => t.id),
        removedTags: plan.removeTags.map(t => ({ tag: { ...t }, index: tags.indexOf(t) })),
        entityBefore: {},
        tagNotes: {},
        tagPrivate: {},
    };

    // 1) create missing targets with ST's full tag shape (see ST newTag())
    let sortOrder = Math.max(0, ...tags.map(t => Number.isFinite(t.sort_order) ? t.sort_order : 0));
    for (const t of plan.newTargets) {
        tags.push({
            id: t.id,
            name: t.name,
            folder_type: 'NONE',
            filter_state: DEFAULT_FILTER_STATE,
            sort_order: ++sortOrder,
            is_hidden_on_character_card: false,
            color: '',
            color2: '',
            create_date: Date.now(),
        });
    }

    // 2) rewrite each affected entity against its ORIGINAL tags (no cascade)
    const keys = new Set(plan.applied.flatMap(a => a.entityKeys));
    let changed = 0;
    for (const key of keys) {
        const arr = tag_map[key];
        const original = [...arr];
        const fired = plan.applied.filter(a => a.sources.some(s => original.includes(s.id)));
        const firedSourceIds = new Set(fired.flatMap(a => a.sources.map(s => s.id)));

        const next = original.filter(id => !firedSourceIds.has(id));
        fired.flatMap(a => a.targets).forEach(t => { if (!next.includes(t.id)) next.push(t.id); });

        if (next.length !== original.length || next.some((id, i) => id !== original[i])) {
            undo.entityBefore[key] = original;
            arr.splice(0, arr.length, ...next); // mutate in place, ST holds references
            changed++;
        }
    }

    // 3) delete source tags and their notes / private-folder flags
    for (let i = tags.length - 1; i >= 0; i--) {
        if (removeIds.has(tags[i].id)) tags.splice(i, 1);
    }
    for (const id of removeIds) {
        if (notes.tagNotes && id in notes.tagNotes) {
            undo.tagNotes[id] = notes.tagNotes[id];
            delete notes.tagNotes[id];
        }
        if (notes.tagPrivate && id in notes.tagPrivate) {
            undo.tagPrivate[id] = notes.tagPrivate[id];
            delete notes.tagPrivate[id];
        }
    }
    saveNotes(notes);

    return { undo, changed };
}

async function undoConversion(undo) {
    // restore entity tag arrays
    for (const [key, original] of Object.entries(undo.entityBefore)) {
        if (Array.isArray(tag_map[key])) tag_map[key].splice(0, tag_map[key].length, ...original);
        else tag_map[key] = [...original];
    }

    // remove created tags that nothing references any more
    const stillUsed = new Set(Object.values(tag_map).flat());
    for (const id of undo.createdIds) {
        const i = tags.findIndex(t => t.id === id);
        if (i !== -1 && !stillUsed.has(id)) tags.splice(i, 1);
    }

    // re-insert removed source tags at their old positions (ascending)
    [...undo.removedTags].sort((a, b) => a.index - b.index).forEach(({ tag, index }) => {
        if (tags.some(t => t.id === tag.id)) return;
        tags.splice(Math.min(index, tags.length), 0, tag);
    });

    const notes = getNotes();
    notes.tagNotes = { ...(notes.tagNotes || {}), ...undo.tagNotes };
    notes.tagPrivate = { ...(notes.tagPrivate || {}), ...undo.tagPrivate };
    saveNotes(notes);

    await refreshAll();
    toastr.success('Tag conversion undone.');
}

async function refreshAll() {
    await callSaveandReload();
    renderTagSection();
    renderCharacterList();
    populateAssignTagSelect();
}

async function runConversion(rules) {
    if (!rules.length) {
        toastr.info('No conversion rules defined.');
        return;
    }
    const plan = resolveConversion(rules);
    if (!plan.applied.length) {
        toastr.info(`None of the ${rules.length} rule${rules.length === 1 ? '' : 's'} matched an existing tag. Nothing to convert.`);
        return;
    }
    if (!(await showPreview(plan))) return;

    const { undo, changed } = applyConversion(plan);
    await refreshAll();

    toastr.success(`Applied ${plan.applied.length} rule${plan.applied.length === 1 ? '' : 's'}: `
        + `${changed} character${changed === 1 ? '' : 's'} changed, `
        + `${plan.newTargets.length} tag${plan.newTargets.length === 1 ? '' : 's'} created, `
        + `${plan.removeTags.length} removed.`);

    const res = await callGenericPopup(
        `<h3>Tags converted</h3><p>${changed} character${changed === 1 ? '' : 's'} changed. Undo restores the previous tags and assignments.</p>`,
        POPUP_TYPE.CONFIRM, '', { okButton: 'Undo', cancelButton: 'Close' });
    if (res === POPUP_RESULT.AFFIRMATIVE) await undoConversion(undo);
}
