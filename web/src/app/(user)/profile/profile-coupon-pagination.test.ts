import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("profile coupon pagination", () => {
    it("loads only the active server page and refreshes page one after a claim", async () => {
        const hook = await readFile(resolve(process.cwd(), "src/app/(user)/profile/use-profile-data.ts"), "utf8");

        expect(hook).toContain("pageSize: COUPON_PAGE_SIZE");
        expect(hook).not.toContain("pageSize: 100");
        expect(hook).toContain("loadCoupons(couponsPage)");
        expect(hook).toContain("setCouponsPage(1)");
        expect(hook).toContain("couponsQueuedRequest");
        expect(hook).toContain("couponTemplatesLoaded");
        expect(hook).toContain("templatePageSize: COUPON_PAGE_SIZE");
        expect(hook).toContain("changeCouponTemplatePage");
        expect(hook).toContain("refreshTemplates: true");
        expect(hook).toContain("includeTemplates: currentRequest.refreshTemplates || !couponTemplatesLoaded.current");
    });

    it("keeps billing and coupon controls out of the workbench profile", async () => {
        const [wallet, page] = await Promise.all([readFile(resolve(process.cwd(), "src/app/(user)/profile/profile-coupon-wallet.tsx"), "utf8"), readFile(resolve(process.cwd(), "src/app/(user)/profile/page.tsx"), "utf8")]);

        expect(wallet).toContain("total > COUPON_PAGE_SIZE");
        expect(wallet).toContain("templatesTotal > COUPON_PAGE_SIZE");
        expect(wallet).toContain("current={templatePage}");
        expect(wallet).toContain("<Pagination");
        expect(wallet).toContain("current={page}");
        expect(wallet).toContain("onChange={onPageChange}");
        expect(page).not.toContain("onClaimed={coupons.refreshAfterClaim}");
        expect(page).not.toContain("section=points");
        expect(page).not.toContain("section=billing");
    });
});
