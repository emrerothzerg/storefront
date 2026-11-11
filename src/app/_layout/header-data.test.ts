import { beforeEach, describe, expect, mock, test } from "bun:test";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import type { DepartmentInput } from "@/components/molecules/DepartmentMenu";
import type { Category } from "@/lib/types";

import {
  POPULAR_SEARCH_COUNT,
  freeShippingThreshold,
  loadHeaderData,
  resetHeaderDataLogState,
  type HeaderDataDeps,
} from "./header-data";

const SESSION = "11111111-1111-4111-8111-111111111111";

function dept(id: string, name: string): DepartmentInput {
  const base = { id, slug: id, name, parentId: null, sortOrder: 0 } as Category;
  return { ...base, children: [] };
}

function deps(overrides: Partial<HeaderDataDeps> = {}): HeaderDataDeps & { logger: { error: ReturnType<typeof mock> } } {
  return {
    readSessionId: async () => SESSION,
    readCurrentUser: async () => null,
    getCartTotals: () => ({ itemCount: 3 }),
    categoryTree: () => [dept("electronics", "Electronics"), dept("home", "Home")],
    listPromoted: () => [
      { code: "FREESHIP", description: "Free shipping on orders of $20.00 or more" },
      { code: "WELCOME10", description: "10% off" },
    ],
    listShippingMethods: () => [
      { freeOverCents: 3500, isActive: true },
      { freeOverCents: null, isActive: true },
    ],
    logger: { error: mock(() => {}) },
    ...overrides,
  } as HeaderDataDeps & { logger: { error: ReturnType<typeof mock> } };
}

/**
 * A Next redirect control-flow error, built from its digest (what
 * `unstable_rethrow` inspects). Not created via `redirect()` because other
 * suites replace `next/navigation`'s `redirect` with a mock process-wide.
 */
function redirectError(): Error {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = "NEXT_REDIRECT;replace;/elsewhere;307;";
  if (!isRedirectError(error)) throw new Error("digest format changed: not a Next redirect error");
  return error;
}

beforeEach(() => {
  resetHeaderDataLogState();
});

describe("loadHeaderData", () => {
  test("guest with a cart: count, departments, popular searches, first promoted coupon", async () => {
    const data = await loadHeaderData(deps());
    expect(data.cartCount).toBe(3);
    expect(data.user).toBeNull();
    expect(data.departments.map((d) => d.slug)).toEqual(["electronics", "home"]);
    expect(data.popularSearches).toEqual(["Electronics", "Home"]);
    expect(data.promoCoupon).toEqual({ code: "FREESHIP", description: "Free shipping on orders of $20.00 or more" });
  });

  test("no session cookie: the cart is never read and the count is 0", async () => {
    const getCartTotals = mock(() => ({ itemCount: 9 }));
    const data = await loadHeaderData(deps({ readSessionId: async () => null, getCartTotals }));
    expect(getCartTotals).not.toHaveBeenCalled();
    expect(data.cartCount).toBe(0);
  });

  test("signed-in user is reduced to displayName (no id, email or owner key in props)", async () => {
    const user = { id: "u1", email: "ada@example.com", displayName: "Ada", ownerKey: "secret" };
    const data = await loadHeaderData(deps({ readCurrentUser: async () => user }));
    expect(data.user).toEqual({ displayName: "Ada" });
    expect(JSON.stringify(data)).not.toContain("ada@example.com");
    expect(JSON.stringify(data)).not.toContain("secret");
  });

  test("the cart is read with the session id from readSessionId", async () => {
    const getCartTotals = mock((id: string) => ({ itemCount: id === SESSION ? 1 : 0 }));
    await loadHeaderData(deps({ getCartTotals }));
    expect(getCartTotals).toHaveBeenCalledWith(SESSION);
  });

  test("request-scoped readers run before any database reader", async () => {
    const calls: string[] = [];
    await loadHeaderData(
      deps({
        readSessionId: async () => {
          calls.push("session");
          return SESSION;
        },
        readCurrentUser: async () => {
          calls.push("user");
          return null;
        },
        getCartTotals: () => {
          calls.push("cart");
          return { itemCount: 0 };
        },
        categoryTree: () => {
          calls.push("categories");
          return [];
        },
        listPromoted: () => {
          calls.push("coupons");
          return [];
        },
      }),
    );
    expect(calls.slice(0, 2).sort()).toEqual(["session", "user"]);
    expect(calls.slice(2)).toEqual(["cart", "categories", "coupons"]);
  });

  test("a request-scope abort from readSessionId propagates and no database reader runs", async () => {
    const categoryTree = mock(() => []);
    const abort = redirectError();
    await expect(
      loadHeaderData(
        deps({
          readSessionId: async () => {
            throw abort;
          },
          categoryTree,
        }),
      ),
    ).rejects.toBe(abort);
    expect(categoryTree).not.toHaveBeenCalled();
  });

  test("readSessionId failure (database down in the cookie lookup) falls back to a guest header without reading the cart", async () => {
    const getCartTotals = mock(() => ({ itemCount: 9 }));
    const d = deps({
      readSessionId: async () => {
        throw new Error(`SQLITE_IOERR for session ${SESSION}`);
      },
      readCurrentUser: async () => ({ displayName: "Ada" }),
      getCartTotals,
    });
    const data = await loadHeaderData(d);
    expect(getCartTotals).not.toHaveBeenCalled();
    expect(data.cartCount).toBe(0);
    expect(data.user).toEqual({ displayName: "Ada" });
    expect(data.departments.length).toBe(2);
    expect(d.logger.error).toHaveBeenCalledTimes(1);
  });

  test("readCurrentUser failure falls back to guest (user null); the cart still renders", async () => {
    const d = deps({
      readCurrentUser: async () => {
        throw new Error("SQLITE_BUSY");
      },
    });
    const data = await loadHeaderData(d);
    expect(data.user).toBeNull();
    expect(data.cartCount).toBe(3);
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    expect(String(d.logger.error.mock.calls[0]?.[0])).toContain("user");
  });

  test("synchronous throws from the request-scoped readers are guarded too", async () => {
    const d = deps({
      readSessionId: () => {
        throw new Error("sync boom");
      },
      readCurrentUser: () => {
        throw new Error("sync boom");
      },
    });
    const data = await loadHeaderData(d);
    expect(data.cartCount).toBe(0);
    expect(data.user).toBeNull();
  });

  test("request-scoped reader failures log once per reader, with the error name only (no message or cookie data)", async () => {
    const secretError = new TypeError(`cookie value ${SESSION} rejected`);
    const d = deps({
      readSessionId: async () => {
        throw secretError;
      },
      readCurrentUser: async () => {
        throw secretError;
      },
    });
    await loadHeaderData(d);
    await loadHeaderData(d);
    expect(d.logger.error).toHaveBeenCalledTimes(2);
    const messages = d.logger.error.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("session"))).toBe(true);
    expect(messages.some((m) => m.includes("user"))).toBe(true);
    for (const call of d.logger.error.mock.calls) {
      expect(call[1]).toEqual({ name: "TypeError" });
      expect(JSON.stringify(call)).not.toContain(SESSION);
      expect(call).not.toContain(secretError);
    }
  });

  test("a Next control-flow error from readCurrentUser propagates and is not logged", async () => {
    const abort = redirectError();
    const d = deps({
      readCurrentUser: async () => {
        throw abort;
      },
    });
    await expect(loadHeaderData(d)).rejects.toBe(abort);
    expect(d.logger.error).not.toHaveBeenCalled();
  });

  test("database errors fall back (0 items, no departments, no coupon) and log once per reader", async () => {
    const boom = () => {
      throw new Error("SQLITE_BUSY");
    };
    const d = deps({ getCartTotals: boom, categoryTree: boom, listPromoted: boom });
    const first = await loadHeaderData(d);
    expect(first).toEqual({
      cartCount: 0,
      user: null,
      departments: [],
      popularSearches: [],
      promoCoupon: null,
      freeShippingThresholdCents: 3500,
    });
    expect(d.logger.error).toHaveBeenCalledTimes(3);
    const messages = d.logger.error.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("cart"))).toBe(true);
    expect(messages.some((m) => m.includes("categories"))).toBe(true);
    expect(messages.some((m) => m.includes("coupons"))).toBe(true);
    await loadHeaderData(d);
    expect(d.logger.error).toHaveBeenCalledTimes(3);
  });

  test("one failing reader does not affect the others", async () => {
    const data = await loadHeaderData(
      deps({
        categoryTree: () => {
          throw new Error("down");
        },
      }),
    );
    expect(data.cartCount).toBe(3);
    expect(data.departments).toEqual([]);
    expect(data.promoCoupon?.code).toBe("FREESHIP");
  });

  test("Next control-flow errors thrown by a database reader are rethrown, not swallowed", async () => {
    const abort = redirectError();
    const d = deps({
      listPromoted: () => {
        throw abort;
      },
    });
    await expect(loadHeaderData(d)).rejects.toBe(abort);
    expect(d.logger.error).not.toHaveBeenCalled();
  });

  test("invalid cart counts become 0", async () => {
    expect((await loadHeaderData(deps({ getCartTotals: () => ({ itemCount: -2 }) }))).cartCount).toBe(0);
    expect((await loadHeaderData(deps({ getCartTotals: () => ({ itemCount: Number.NaN }) }))).cartCount).toBe(0);
  });

  test("popular searches: unique, non-empty department names, at most POPULAR_SEARCH_COUNT", async () => {
    const many = ["A", "B", " ", "B", "C", "D", "E", "F", "G"].map((n, i) => dept(`d${i}`, n));
    const data = await loadHeaderData(deps({ categoryTree: () => many }));
    expect(POPULAR_SEARCH_COUNT).toBe(5);
    expect(data.popularSearches).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("no promoted coupons -> null", async () => {
    expect((await loadHeaderData(deps({ listPromoted: () => [] }))).promoCoupon).toBeNull();
  });

  // T148: FREE_SHIPPING_MESSAGE (a hardcoded "$35" copy of the seeded threshold) was
  // removed; the threshold now comes from the shipping methods (tests below).
  test("free-shipping threshold comes from the shipping methods (lowest active positive freeOverCents)", async () => {
    expect((await loadHeaderData(deps())).freeShippingThresholdCents).toBe(3500);
    const other = await loadHeaderData(
      deps({
        listShippingMethods: () => [
          { freeOverCents: 9000 },
          { freeOverCents: 5000, isActive: true },
          { freeOverCents: 100, isActive: false },
        ],
      }),
    );
    expect(other.freeShippingThresholdCents).toBe(5000);
  });

  test("no shipping reader, no free method or only malformed thresholds -> null", async () => {
    expect((await loadHeaderData(deps({ listShippingMethods: undefined }))).freeShippingThresholdCents).toBeNull();
    expect((await loadHeaderData(deps({ listShippingMethods: () => [] }))).freeShippingThresholdCents).toBeNull();
    expect(
      (
        await loadHeaderData(
          deps({
            listShippingMethods: () => [
              { freeOverCents: null },
              { freeOverCents: 0 },
              { freeOverCents: -5 },
              { freeOverCents: 12.5 },
              { freeOverCents: Number.NaN },
              { freeOverCents: Number.MAX_SAFE_INTEGER + 2 },
            ],
          }),
        )
      ).freeShippingThresholdCents,
    ).toBeNull();
    expect(freeShippingThreshold(null)).toBeNull();
    expect(freeShippingThreshold([null as unknown as { freeOverCents: number }, { freeOverCents: 700 }])).toBe(700);
  });

  test("a failing shipping reader falls back to null, logs once, leaves the others intact", async () => {
    const d = deps({
      listShippingMethods: () => {
        throw new Error("SQLITE_ERROR: no such table: shipping_methods");
      },
    });
    const first = await loadHeaderData(d);
    await loadHeaderData(d);
    expect(first.freeShippingThresholdCents).toBeNull();
    expect(first.cartCount).toBe(3);
    expect(first.promoCoupon?.code).toBe("FREESHIP");
    expect(d.logger.error).toHaveBeenCalledTimes(1);
    expect(String(d.logger.error.mock.calls[0]?.[0])).toContain("shipping");
  });

  test("a Next control-flow error from the shipping reader is rethrown, not logged", async () => {
    const abort = redirectError();
    const d = deps({
      listShippingMethods: () => {
        throw abort;
      },
    });
    await expect(loadHeaderData(d)).rejects.toBe(abort);
    expect(d.logger.error).not.toHaveBeenCalled();
  });

  test("the shipping reader runs after the request-scoped readers", async () => {
    const calls: string[] = [];
    await loadHeaderData(
      deps({
        readSessionId: async () => {
          calls.push("session");
          return null;
        },
        readCurrentUser: async () => {
          calls.push("user");
          return null;
        },
        listShippingMethods: () => {
          calls.push("shipping");
          return [];
        },
      }),
    );
    expect(calls.slice(0, 2).sort()).toEqual(["session", "user"]);
    expect(calls[2]).toBe("shipping");
  });
});
