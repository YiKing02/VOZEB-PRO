import { NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import { checkRateLimit } from "@/lib/server/security";
import { deleteUserNewApiConfig, getPublicUserNewApiConfig, saveUserNewApiConfig, UserNewApiConfigError, type UserNewApiCredentialCapability } from "@/lib/server/user-newapi-config";

export const runtime = "nodejs";

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!(await getAuthSettings()).allowUserApiConfig) return NextResponse.json({ error: "用户接口配置未启用" }, { status: 403 });
    return NextResponse.json({ config: await getPublicUserNewApiConfig(user.id) });
}

export async function PUT(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!(await getAuthSettings()).allowUserApiConfig) return NextResponse.json({ error: "用户接口配置未启用" }, { status: 403 });
    const limit = await checkRateLimit(`user-newapi-config:${user.id}`, { maxRequests: 10, windowMs: 15 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "操作过于频繁，请稍后重试", retryAfter: Math.ceil((limit.resetAt - Date.now()) / 1000) }, { status: 429 });
    try {
        const body = await readJsonBody<{ baseUrl?: unknown; apiKey?: unknown; credentials?: Partial<Record<UserNewApiCredentialCapability, { baseUrl?: unknown; apiKey?: unknown }>> }>(request);
        const credentials = body.credentials
            ? (Object.fromEntries(Object.entries(body.credentials).map(([capability, value]) => [capability, { baseUrl: value?.baseUrl, apiKey: value?.apiKey }])) as Parameters<typeof saveUserNewApiConfig>[1]["credentials"])
            : undefined;
        return NextResponse.json({
            config: await saveUserNewApiConfig(user.id, { baseUrl: body.baseUrl, apiKey: body.apiKey, credentials }),
        });
    } catch (error) {
        if (error instanceof UserNewApiConfigError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("User New API config update failed", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "接口配置保存失败" }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!(await getAuthSettings()).allowUserApiConfig) return NextResponse.json({ error: "用户接口配置未启用" }, { status: 403 });
    try {
        await deleteUserNewApiConfig(user.id);
        return NextResponse.json({ ok: true });
    } catch (error) {
        if (error instanceof UserNewApiConfigError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("User New API config delete failed", error instanceof Error ? error.message : error);
        return NextResponse.json({ error: "接口配置清除失败" }, { status: 500 });
    }
}
