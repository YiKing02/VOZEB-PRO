import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImageTask } from "@/lib/server/image-task-store";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";

import { runOpenAiImageTask } from "./image-task-openai";
import { ImageUpstreamTerminalError, parseImagePayloadCompat, pollOpenAiImageTask } from "./image-task-support";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4q2JAAAAAElFTkSuQmCC";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

afterEach(() => {
    vi.unstubAllEnvs();
});

function task(origin: string, kind: ImageTask["kind"], references: ImageTask["references"] = []): ImageTask {
    return {
        id: `newapi-${kind}`,
        userId: "user-one",
        username: "user",
        displayName: "User",
        kind,
        source: "image-workbench",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        prompt: "draw a blue square",
        references,
        config: {
            baseUrl: `${origin}/v1`,
            apiKey: "fixture-key",
            apiFormat: "openai",
            model: "newapi-image",
            channelId: "newapi-fixture",
            advancedConfig: {
                ...emptyAdvancedConfig(),
                protocol: "newapi",
                createPath: "/images/generations/async",
                editPath: "/images/edits/async",
                queryPath: "/images/tasks/:task_id",
                resultField: "result.data[0].url / result.data[0].b64_json",
                statusField: "status",
                referenceRule: "multipart/form-data",
                supportsReferenceImage: true,
            },
        },
        candidateConfigs: [],
    };
}

describe("New API asynchronous image protocol", () => {
    it("uses async JSON creation, multipart edits, and polls nested result data", async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");

        const requests: Array<{ method: string; path: string; contentType: string; body: string }> = [];
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks).toString("utf8");
            requests.push({ method: request.method || "", path: new URL(request.url || "/", `http://${request.headers.host}`).pathname, contentType: String(request.headers["content-type"] || ""), body });
            const path = requests.at(-1)?.path;
            if (request.method === "POST" && path === "/v1/images/generations/async") {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ task_id: "generation-task", status: "running" }));
                return;
            }
            if (request.method === "POST" && path === "/v1/images/edits/async") {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ task_id: "edit-task", status: "running" }));
                return;
            }
            if (request.method === "GET" && path === "/v1/images/tasks/generation-task") {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ task_id: "generation-task", status: "success", result: { data: [{ url: `${origin}/media/generated.png` }] } }));
                return;
            }
            if (request.method === "GET" && path === "/v1/images/tasks/edit-task") {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ task_id: "edit-task", status: "success", result: { data: [{ b64_json: PNG_BASE64 }] } }));
                return;
            }
            response.statusCode = 404;
            response.end(JSON.stringify({ status: "failed" }));
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("New API fixture did not bind");
        const origin = `http://127.0.0.1:${address.port}`;

        try {
            const generationTask = task(origin, "generation");
            const submitted = await runOpenAiImageTask(generationTask, "http://internal", "http://public", "", true);
            expect(submitted.pending).toMatchObject({ id: "generation-task" });

            const polled = await pollOpenAiImageTask(generationTask.config, "generation-task", `${origin}/v1`, `${origin}/v1/images/generations/async`, "", "", true);
            expect(polled.remoteUrl).toBe(`${origin}/media/generated.png`);

            const editTask = task(origin, "edit", [{ type: "image/png", dataUrl: PNG_DATA_URL }]);
            const editSubmitted = await runOpenAiImageTask(editTask, "http://internal", "http://public", "", true);
            expect(editSubmitted.pending).toMatchObject({ id: "edit-task" });
            const edited = await pollOpenAiImageTask(editTask.config, "edit-task", `${origin}/v1`, `${origin}/v1/images/edits/async`, "", "", true);
            expect(edited.dataUrl).toBe(PNG_DATA_URL);

            expect(requests.map((request) => [request.method, request.path])).toEqual([
                ["POST", "/v1/images/generations/async"],
                ["GET", "/v1/images/tasks/generation-task"],
                ["POST", "/v1/images/edits/async"],
                ["GET", "/v1/images/tasks/edit-task"],
            ]);
            expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "newapi-image", prompt: "draw a blue square" });
            expect(requests[2]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
            expect(requests[2]!.body).toContain('name="model"');
            expect(requests[2]!.body).toContain('name="image"');
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("recognizes New API running and failed states", () => {
        const config = task("https://newapi.example", "generation").config;

        expect(parseImagePayloadCompat({ task_id: "task-one", status: "running" }, "https://newapi.example/v1", config)).toBeNull();
        expect(() => parseImagePayloadCompat({ task_id: "task-one", status: "failed", msg: "upstream rejected image" }, "https://newapi.example/v1", config)).toThrow(ImageUpstreamTerminalError);
    });
});
