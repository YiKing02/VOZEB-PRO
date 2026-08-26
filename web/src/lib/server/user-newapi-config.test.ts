import { describe, expect, it } from "vitest";

import type { AuthSettings } from "@/lib/auth/store";
import { DEFAULT_SETTINGS } from "@/lib/auth/store-foundation";
import { normalizeSettings } from "@/lib/auth/store-normalizers";
import { getUserGenerationSettings, mergeUserGenerationSettings, normalizeNewApiBaseUrl, UserNewApiConfigError } from "./user-newapi-config";

describe("user New API config", () => {
    it("normalizes a New API models URL to its API base", () => {
        expect(normalizeNewApiBaseUrl("https://newapi.example.com/v1/models")).toBe("https://newapi.example.com/v1");
    });

    it.each(["http://newapi.example.com", "https://user:password@newapi.example.com", "https://newapi.example.com?token=secret", "https://newapi.example.com/#fragment"])("rejects unsafe URL %s", (url) => {
        expect(() => normalizeNewApiBaseUrl(url)).toThrow(UserNewApiConfigError);
    });

    it("preserves shared channels when personal configuration is disabled", async () => {
        const sharedSettings = {
            allowUserApiConfig: false,
            systemChannels: [{ id: "shared-channel" }],
            logicalModels: [{ id: "shared-model" }],
            defaultModels: { textModel: "shared-model", imageModel: "shared-model", videoModel: "shared-model", audioModel: "shared-model" },
        } as unknown as AuthSettings;

        await expect(getUserGenerationSettings(sharedSettings, "user-one")).resolves.toBe(sharedSettings);
    });

    it("overlays personal image routing without removing shared text and video routing", () => {
        const sharedSettings = {
            allowUserApiConfig: true,
            systemChannels: [
                { id: "shared-text", enabled: true, models: ["shared-text-model"] },
                { id: "shared-video", enabled: true, models: ["shared-video-model"] },
            ],
            logicalModels: [
                { id: "shared-text-model", capability: "text", enabled: true, bindings: [{ id: "text-binding", channelId: "shared-text", upstreamModel: "shared-text-model", enabled: true, priority: 1 }] },
                { id: "shared-video-model", capability: "video", enabled: true, bindings: [{ id: "video-binding", channelId: "shared-video", upstreamModel: "shared-video-model", enabled: true, priority: 1 }] },
            ],
            defaultModels: { textModel: "shared-text-model", imageModel: "", videoModel: "shared-video-model", audioModel: "" },
        } as unknown as AuthSettings;
        const personalChannel = {
            id: "user-newapi",
            enabled: true,
            models: ["grok-image-opaque"],
            advancedConfig: { modelCapabilities: { "grok-image-opaque": "image" } },
        } as unknown as AuthSettings["systemChannels"][number];

        const merged = mergeUserGenerationSettings(sharedSettings, personalChannel);
        expect(merged.systemChannels.map((channel) => channel.id)).toEqual(["shared-text", "shared-video", "user-newapi"]);
        expect(merged.logicalModels.map((model) => [model.id, model.capability])).toEqual([
            ["shared-text-model", "text"],
            ["shared-video-model", "video"],
            ["grok-image-opaque", "image"],
        ]);
        expect(merged.defaultModels).toMatchObject({ textModel: "shared-text-model", videoModel: "shared-video-model", imageModel: "grok-image-opaque" });
    });

    it("preserves the database-backed personal configuration switch", () => {
        expect(normalizeSettings({ ...structuredClone(DEFAULT_SETTINGS), allowUserApiConfig: true }).allowUserApiConfig).toBe(true);
    });
});
