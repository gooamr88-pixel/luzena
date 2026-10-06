// An in-memory stand-in for the Clover REST API, covering only the endpoints this project
// calls, with the request and response shapes shown in Clover's documentation.
//
// THIS IS A TEST DOUBLE. It proves how OUR code behaves for a given Clover response. It is
// NOT evidence of how the real Clover API behaves; that needs a sandbox run.

const json = (status, body, headers = {}) =>
  new Response(body === null ? "" : JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers },
  });

const wrap = (elements) => ({ elements });

export class FakeClover {
  constructor(merchantId = "MERCHANT00001") {
    this.merchantId = merchantId;
    this.items = new Map();
    this.categories = new Map();
    this.groups = new Map();
    this.modifiers = new Map();
    this.itemCategories = new Set();
    this.itemGroups = new Set();
    this.faults = [];
    this.calls = [];
    this.sequence = 0;
    this.clock = 1_750_000_000_000;
    this.tokenGeneration = 1;
    this.refreshCalls = 0;
    this.authCode = "good-code";
    this.accessLifetimeSeconds = 3600;
  }

  get accessToken() { return `access-${this.tokenGeneration}`; }
  get refreshToken() { return `refresh-${this.tokenGeneration}`; }

  newId(prefix) {
    this.sequence += 1;
    return (prefix + String(this.sequence).padStart(13, "0")).slice(0, 4).toUpperCase() + String(this.sequence).padStart(9, "0");
  }

  // Strictly increasing and never behind the wall clock, like Clover's modifiedTime.
  tick() { this.clock = Math.max(this.clock + 1, Date.now()); return this.clock; }

  addCategory(name, sortOrder) {
    const id = this.newId("CATG");
    this.categories.set(id, { id, name, sortOrder: sortOrder ?? this.categories.size + 1 });
    return id;
  }

  addItem(name, price, extra = {}) {
    const id = this.newId("ITEM");
    this.items.set(id, { id, name, price, priceType: "FIXED", hidden: false, available: true, modifiedTime: this.tick(), ...extra });
    return id;
  }

  addGroup(name, extra = {}) {
    const id = this.newId("GRUP");
    this.groups.set(id, { id, name, showByDefault: true, ...extra });
    return id;
  }

  addModifier(groupId, name, price = 0) {
    const id = this.newId("MODF");
    this.modifiers.set(id, { id, name, price, available: true, modifierGroup: { id: groupId } });
    return id;
  }

  link(itemId, categoryId) { this.itemCategories.add(`${itemId}|${categoryId}`); }
  linkGroup(itemId, groupId) { this.itemGroups.add(`${itemId}|${groupId}`); }

  // mode: "status" (respond with `status`, nothing applied)
  //       "drop_before" (connection fails, nothing applied)
  //       "drop_after"  (the write IS applied, then the connection fails)
  fault({ method, path, mode = "status", status = 500, times = 1, headers = {} }) {
    this.faults.push({ method, path, mode, status, times, headers });
  }

  callsTo(method, pattern) {
    return this.calls.filter((call) => call.method === method && pattern.test(call.path));
  }

  itemJson(item, expand) {
    const out = { ...item };
    if (expand.includes("categories")) {
      out.categories = wrap([...this.itemCategories].filter((l) => l.startsWith(`${item.id}|`)).map((l) => ({ id: l.split("|")[1] })));
    }
    if (expand.includes("modifierGroups")) {
      out.modifierGroups = wrap([...this.itemGroups].filter((l) => l.startsWith(`${item.id}|`)).map((l) => ({ id: l.split("|")[1] })));
    }
    return out;
  }

  groupJson(group, expand) {
    const out = { ...group };
    if (expand.includes("modifiers")) {
      out.modifiers = wrap([...this.modifiers.values()].filter((m) => m.modifierGroup.id === group.id));
    }
    return out;
  }

  fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const path = url.pathname;
    this.calls.push({ method, path, query: url.search, body });

    const fault = this.faults.find((f) => f.method === method && f.path.test(path) && f.times > 0);
    if (fault) {
      fault.times -= 1;
      if (fault.mode === "status") return json(fault.status, { message: "simulated" }, fault.headers);
      if (fault.mode === "drop_before") throw new TypeError("simulated network failure");
      if (fault.mode === "drop_after") {
        this.route(method, url, body, init);
        throw Object.assign(new Error("simulated timeout"), { name: "TimeoutError" });
      }
    }
    return this.route(method, url, body, init);
  };

  route(method, url, body, init) {
    const path = url.pathname;
    if (path === "/oauth/v2/token") {
      if (body.code !== this.authCode || !body.client_secret) return json(400, { message: "invalid code" });
      return json(200, this.tokenBody());
    }
    if (path === "/oauth/v2/refresh") {
      this.refreshCalls += 1;
      if (body.refresh_token !== this.refreshToken) return json(400, { message: "invalid refresh token" });
      this.tokenGeneration += 1;
      return json(200, this.tokenBody());
    }

    const authorization = new Headers(init.headers).get("authorization");
    if (authorization !== `Bearer ${this.accessToken}`) return json(401, { message: "unauthorized" });

    const prefix = `/v3/merchants/${this.merchantId}`;
    if (!path.startsWith(prefix)) return json(404, { message: "no such merchant" });
    const rest = path.slice(prefix.length);
    const expand = (url.searchParams.get("expand") ?? "").split(",").filter(Boolean);
    const page = (list) => {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json(200, wrap(list.slice(offset, offset + limit)));
    };
    let match;

    if (rest === "" && method === "GET") return json(200, { id: this.merchantId, name: "Fake Merchant" });

    if (rest === "/items" && method === "GET") {
      let list = [...this.items.values()];
      for (const filter of url.searchParams.getAll("filter")) {
        if (filter.startsWith("name=")) list = list.filter((i) => i.name === filter.slice(5));
        if (filter.startsWith("modifiedTime>=")) list = list.filter((i) => i.modifiedTime >= Number(filter.slice(14)));
      }
      return page(list.map((item) => this.itemJson(item, expand)));
    }
    if (rest === "/items" && method === "POST") {
      const id = this.newId("ITEM");
      const item = { id, name: body.name, price: body.price, priceType: body.priceType ?? "FIXED",
        hidden: body.hidden ?? false, available: body.available ?? true, modifiedTime: this.tick() };
      this.items.set(id, item);
      return json(200, item);
    }
    if ((match = rest.match(/^\/items\/([A-Z0-9]{13})$/))) {
      const item = this.items.get(match[1]);
      if (!item) return json(404, { message: "not found" });
      if (method === "POST") Object.assign(item, body, { modifiedTime: this.tick() });
      return json(200, this.itemJson(item, method === "GET" ? expand : []));
    }

    if (rest === "/categories" && method === "GET") {
      return page([...this.categories.values()].map((category) => expand.includes("items")
        ? { ...category, items: wrap([...this.itemCategories].filter((l) => l.endsWith(`|${category.id}`)).map((l) => ({ id: l.split("|")[0] }))) }
        : category));
    }
    if (rest === "/categories" && method === "POST") {
      const id = this.newId("CATG");
      const category = { id, name: body.name, sortOrder: this.categories.size + 1 };
      this.categories.set(id, category);
      return json(200, category);
    }
    if ((match = rest.match(/^\/categories\/([A-Z0-9]{13})$/)) && method === "POST") {
      const category = this.categories.get(match[1]);
      if (!category) return json(404, { message: "not found" });
      Object.assign(category, body);
      return json(200, category);
    }

    if (rest === "/category_items" || rest === "/item_modifier_groups") {
      const set = rest === "/category_items" ? this.itemCategories : this.itemGroups;
      const other = rest === "/category_items" ? "category" : "modifierGroup";
      for (const element of body.elements) {
        const key = `${element.item.id}|${element[other].id}`;
        if (url.searchParams.get("delete") === "true") set.delete(key); else set.add(key);
        const item = this.items.get(element.item.id);
        if (item) item.modifiedTime = this.tick();
      }
      return json(200, null);
    }

    if (rest === "/modifier_groups" && method === "GET") {
      return page([...this.groups.values()].map((group) => this.groupJson(group, expand)));
    }
    if (rest === "/modifier_groups" && method === "POST") {
      const id = this.newId("GRUP");
      const group = { id, showByDefault: true, ...body };
      this.groups.set(id, group);
      return json(200, group);
    }
    if ((match = rest.match(/^\/modifier_groups\/([A-Z0-9]{13})$/))) {
      const group = this.groups.get(match[1]);
      if (!group) return json(404, { message: "not found" });
      if (method === "POST") Object.assign(group, body);
      return json(200, this.groupJson(group, expand));
    }
    if ((match = rest.match(/^\/modifier_groups\/([A-Z0-9]{13})\/modifiers$/)) && method === "POST") {
      const id = this.newId("MODF");
      const modifier = { id, name: body.name, price: body.price ?? 0, available: true, modifierGroup: { id: match[1] } };
      this.modifiers.set(id, modifier);
      return json(200, modifier);
    }
    if ((match = rest.match(/^\/modifier_groups\/([A-Z0-9]{13})\/modifiers\/([A-Z0-9]{13})$/)) && method === "POST") {
      const modifier = this.modifiers.get(match[2]);
      if (!modifier) return json(404, { message: "not found" });
      Object.assign(modifier, body);
      return json(200, modifier);
    }

    return json(404, { message: `fake Clover has no route for ${method} ${path}` });
  }

  tokenBody() {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: this.accessToken,
      access_token_expiration: now + this.accessLifetimeSeconds,
      refresh_token: this.refreshToken,
      refresh_token_expiration: now + 86400 * 365,
    };
  }
}
