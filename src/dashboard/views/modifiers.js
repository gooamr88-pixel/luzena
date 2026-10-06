// Modifier groups and modifiers. All of it lives in Clover; every save writes to Clover.
import { centsToInput, formatPrice, parsePriceToCents } from "../../js/lib/format.js";
import { api, ApiFailure, newIdempotencyKey } from "../api.js";
import { can, currency, state } from "../state.js";
import { append, badge, clear, errorBlock, formDialog, h, icon, loadingBlock, pageHeader, stateBlock, switchControl, toast, toastFailure } from "../ui.js";

const invalid = (message) => new ApiFailure(422, { code: "validation_failed", message });

// "" means "no limit" (null); otherwise a whole number from 0 to 100.
function parseLimit(text, label) {
  const value = text.trim();
  if (value === "") return null;
  if (!/^\d{1,3}$/.test(value) || Number(value) > 100) throw invalid(`${label} must be a whole number from 0 to 100, or empty.`);
  return Number(value);
}

function parsePrice(text) {
  const cents = parsePriceToCents(text.trim() === "" ? "0" : text);
  if (cents === null) throw invalid("Enter the price as an amount such as 1.50, or leave it empty for no extra charge.");
  return cents;
}

function ruleText(group) {
  const min = group.min_required ?? 0;
  const max = group.max_allowed;
  if (min === 0 && !max) return "Optional, any number";
  if (min > 0 && max === min) return `Required, choose ${min}`;
  if (min > 0) return max ? `Required, choose ${min} to ${max}` : `Required, at least ${min}`;
  return `Optional, up to ${max}`;
}

export async function modifiersView(outlet) {
  const writable = can("menu.write");
  const region = h("div", {});
  let groups = [];

  const accept = (list) => { groups = list; draw(); };
  const limitFields = (group) => [
    { name: "min_required", label: "Minimum choices", source: "Clover", inputmode: "numeric", value: group?.min_required ?? "", hint: "Leave empty or 0 to make the group optional." },
    { name: "max_allowed", label: "Maximum choices", source: "Clover", inputmode: "numeric", value: group?.max_allowed ?? "", hint: "Leave empty for no limit." },
  ];

  const addGroup = () => {
    const key = newIdempotencyKey();
    formDialog({
      title: "Add modifier group",
      intro: "For example \"Doneness\" or \"Add a side\". The group is created in Clover.",
      fields: [{ name: "name", label: "Name", source: "Clover", required: true, maxlength: 127 }, ...limitFields(null)],
      submitLabel: "Create group",
      onSubmit: async (values) => {
        const result = await api("POST", "/modifier-groups", {
          name: values.name.trim(),
          min_required: parseLimit(values.min_required, "Minimum choices"),
          max_allowed: parseLimit(values.max_allowed, "Maximum choices"),
        }, { "idempotency-key": key });
        accept(result.modifier_groups);
        toast(result.message);
      },
    });
  };

  const editGroup = (group) => formDialog({
    title: "Edit modifier group",
    fields: [{ name: "name", label: "Name", source: "Clover", required: true, maxlength: 127, value: group.name }, ...limitFields(group)],
    onSubmit: async (values) => {
      const next = {
        name: values.name.trim(),
        min_required: parseLimit(values.min_required, "Minimum choices"),
        max_allowed: parseLimit(values.max_allowed, "Maximum choices"),
      };
      const before = { name: group.name, min_required: group.min_required ?? null, max_allowed: group.max_allowed ?? null };
      const keys = Object.keys(next).filter((key) => next[key] !== before[key]);
      if (keys.length === 0) return;
      const pick = (object) => Object.fromEntries(keys.map((key) => [key, object[key]]));
      try {
        const result = await api("PATCH", `/modifier-groups/${group.id}`, { clover: pick(next), expected: pick(before) });
        accept(result.modifier_groups);
        toast(result.message);
      } catch (failure) {
        if (failure.details?.modifier_groups) accept(failure.details.modifier_groups);
        throw failure;
      }
    },
  });

  const addModifier = (group) => {
    const key = newIdempotencyKey();
    formDialog({
      title: `Add a modifier to "${group.name}"`,
      fields: [
        { name: "name", label: "Name", source: "Clover", required: true, maxlength: 127 },
        { name: "price", label: `Extra charge (${currency()})`, source: "Clover", inputmode: "decimal", placeholder: "0.00", hint: "Leave empty if it costs nothing extra." },
      ],
      submitLabel: "Create modifier",
      onSubmit: async (values) => {
        const result = await api("POST", `/modifier-groups/${group.id}/modifiers`,
          { name: values.name.trim(), price_cents: parsePrice(values.price) }, { "idempotency-key": key });
        accept(result.modifier_groups);
        toast(result.message);
      },
    });
  };

  const patchModifier = async (group, modifier, clover) => {
    const expected = Object.fromEntries(Object.keys(clover).map((key) => [key, modifier[key]]));
    try {
      const result = await api("PATCH", `/modifier-groups/${group.id}/modifiers/${modifier.id}`, { clover, expected });
      accept(result.modifier_groups);
      toast(result.message);
    } catch (failure) {
      if (failure.details?.modifier_groups) accept(failure.details.modifier_groups);
      throw failure;
    }
  };

  const editModifier = (group, modifier) => formDialog({
    title: "Edit modifier",
    fields: [
      { name: "name", label: "Name", source: "Clover", required: true, maxlength: 127, value: modifier.name },
      { name: "price", label: `Extra charge (${currency()})`, source: "Clover", inputmode: "decimal", value: centsToInput(modifier.price_cents) },
    ],
    onSubmit: async (values) => {
      const next = { name: values.name.trim(), price_cents: parsePrice(values.price) };
      const clover = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== modifier[key]));
      if (Object.keys(clover).length > 0) await patchModifier(group, modifier, clover);
    },
  });

  function draw() {
    clear(region);
    if (groups.length === 0) {
      append(region, stateBlock({
        title: "No modifier groups yet",
        body: "Modifier groups let customers choose options for an item, such as a side or how a steak is cooked. They are imported from Clover, or you can add one here.",
        action: writable && h("button", { type: "button", class: "d-btn d-btn-primary", onClick: addGroup }, "Add modifier group"),
      }));
      return;
    }
    append(region, h("div", { class: "grid items-start gap-4 lg:grid-cols-2" }, groups.map((group) =>
      h("section", { class: "d-card", "aria-labelledby": `group-${group.id}` },
        h("div", { class: "flex flex-wrap items-start justify-between gap-3 border-b border-line p-4" },
          h("div", {},
            h("h2", { id: `group-${group.id}`, class: "text-base" }, group.name),
            h("p", { class: "mt-1 flex flex-wrap items-center gap-2 text-sm text-muted" },
              badge(ruleText(group), (group.min_required ?? 0) > 0 ? "info" : ""),
              `Used by ${group.item_count} ${group.item_count === 1 ? "item" : "items"}`)),
          writable && h("button", { type: "button", class: "d-btn d-btn-sm", onClick: () => editGroup(group) }, "Edit group")),
        group.modifiers.length === 0
          ? h("p", { class: "p-4 text-sm text-muted" }, "No modifiers in this group yet.")
          : h("ul", { class: "divide-y divide-line" }, group.modifiers.map((modifier) =>
              h("li", { class: "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5" },
                h("div", { class: "min-w-0 flex-1" },
                  h("p", { class: `truncate font-medium ${modifier.available ? "" : "text-muted line-through"}` }, modifier.name),
                  h("p", { class: "text-sm text-muted" }, modifier.price_cents > 0 ? `+${formatPrice(modifier.price_cents, currency(), state.locale)}` : "No extra charge")),
                h("label", { class: "flex items-center gap-2 text-sm text-muted" }, "Available",
                  switchControl({
                    checked: modifier.available, label: `${modifier.name}: available`, disabled: !writable,
                    onToggle: (next) => patchModifier(group, modifier, { available: next }).catch(toastFailure),
                  })),
                writable && h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm", onClick: () => editModifier(group, modifier) }, "Edit")))),
        writable && h("div", { class: "border-t border-line p-3" },
          h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm", onClick: () => addModifier(group) }, icon("plus", 16), "Add modifier"))))));
  }

  async function load() {
    clear(region);
    append(region, loadingBlock("Loading modifiers"));
    try {
      accept((await api("GET", "/modifier-groups")).modifier_groups);
    } catch (failure) {
      clear(region);
      append(region, errorBlock(failure, load));
    }
  }

  append(outlet, 
    pageHeader({
      title: "Modifiers",
      actions: writable && h("button", { type: "button", class: "d-btn d-btn-primary", onClick: addGroup }, icon("plus", 16), "Add modifier group"),
    }),
    h("p", { class: "mb-4 max-w-2xl text-sm text-muted" }, "Modifier groups and modifiers are stored in Clover. Assign a group to an item from the item's edit page. To take an option off the menu, switch it to unavailable."),
    region,
  );
  await load();
}
