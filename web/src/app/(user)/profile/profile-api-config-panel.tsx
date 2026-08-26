"use client";

import { useEffect, useState } from "react";
import { App, Button, Input, Tag } from "antd";
import { RefreshCw, Save, Trash2 } from "lucide-react";

import { notifyPublicSettingsChanged } from "@/stores/use-public-session-store";
import { profileDangerButtonClass, profilePrimaryButtonClass, profileSecondaryButtonClass } from "./profile-elements";

type Capability = "text" | "image" | "video";
type PublicCredential = { baseUrl: string; hasApiKey: boolean; enabled: boolean; models: string[]; modelCapabilities: Record<string, "text" | "image" | "video" | "audio"> };
type UserApiConfig = { credentials: Record<Capability, PublicCredential>; hasApiKey: boolean };
type CredentialDraft = { baseUrl: string; apiKey: string };
const CAPABILITIES: Array<{ key: Capability; label: string; hint: string }> = [
    { key: "text", label: "文本模型", hint: "Agent、对话、提示词优化与音频规划" },
    { key: "image", label: "图片模型", hint: "生图、改图与画布图像任务" },
    { key: "video", label: "视频模型", hint: "视频生成、首尾帧与视频 Agent" },
];
const emptyDrafts = (): Record<Capability, CredentialDraft> => ({ text: { baseUrl: "", apiKey: "" }, image: { baseUrl: "", apiKey: "" }, video: { baseUrl: "", apiKey: "" } });

export function ProfileApiConfigPanel() {
    const { message, modal } = App.useApp();
    const [config, setConfig] = useState<UserApiConfig | null>(null);
    const [drafts, setDrafts] = useState<Record<Capability, CredentialDraft>>(emptyDrafts);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [clearing, setClearing] = useState(false);
    const loadConfig = async () => {
        setLoading(true);
        try {
            const response = await fetch("/api/auth/api-config", { cache: "no-store" });
            const payload = (await response.json().catch(() => null)) as { config?: UserApiConfig | null; error?: string } | null;
            if (!response.ok) throw new Error(payload?.error || "接口配置读取失败");
            const next = payload?.config || null;
            setConfig(next);
            if (next) setDrafts((current) => ({ ...current, ...(Object.fromEntries(CAPABILITIES.map(({ key }) => [key, { ...current[key], baseUrl: next.credentials?.[key]?.baseUrl || "" }])) as Record<Capability, CredentialDraft>) }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "接口配置读取失败");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void loadConfig();
    }, []);
    const updateDraft = (capability: Capability, patch: Partial<CredentialDraft>) => setDrafts((current) => ({ ...current, [capability]: { ...current[capability], ...patch } }));
    const saveConfig = async () => {
        const credentials = Object.fromEntries(CAPABILITIES.filter(({ key }) => drafts[key].baseUrl.trim() || drafts[key].apiKey.trim()).map(({ key }) => [key, { baseUrl: drafts[key].baseUrl, apiKey: drafts[key].apiKey || undefined }]));
        if (!Object.keys(credentials).length) {
            message.error("至少填写一组接口 URL");
            return;
        }
        setSaving(true);
        try {
            const response = await fetch("/api/auth/api-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credentials }) });
            const payload = (await response.json().catch(() => null)) as { config?: UserApiConfig; error?: string } | null;
            if (!response.ok || !payload?.config) throw new Error(payload?.error || "接口配置保存失败");
            setConfig(payload.config);
            setDrafts((current) => ({
                ...current,
                ...(Object.fromEntries(CAPABILITIES.map(({ key }) => [key, { ...current[key], apiKey: "", baseUrl: payload.config?.credentials[key]?.baseUrl || current[key].baseUrl }])) as Record<Capability, CredentialDraft>),
            }));
            notifyPublicSettingsChanged();
            message.success("三类接口已验证并保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "接口配置保存失败");
        } finally {
            setSaving(false);
        }
    };
    const clearConfig = () =>
        modal.confirm({
            title: "清除全部接口配置",
            content: "清除后当前账号将无法提交新的生成任务。",
            okText: "清除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                setClearing(true);
                try {
                    const response = await fetch("/api/auth/api-config", { method: "DELETE" });
                    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
                    if (!response.ok) throw new Error(payload?.error || "接口配置清除失败");
                    setConfig(null);
                    setDrafts(emptyDrafts());
                    notifyPublicSettingsChanged();
                    message.success("接口配置已清除");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "接口配置清除失败");
                } finally {
                    setClearing(false);
                }
            },
        });
    return (
        <div className="max-w-4xl space-y-5">
            <div className="rounded-lg border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm leading-6 text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100">
                工作台不代扣积分。请分别填写站点中图片、视频、文本模型分组的 New API URL 与 Key；三组可以来自不同的中转站。
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
                {CAPABILITIES.map(({ key, label, hint }) => {
                    const saved = config?.credentials?.[key];
                    const draft = drafts[key];
                    return (
                        <section key={key} className="min-w-0 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                            <div className="mb-4 flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <h3 className="text-sm font-semibold text-stone-950 dark:text-white">{label}</h3>
                                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{hint}</p>
                                </div>
                                <Tag color={saved?.hasApiKey ? "green" : "default"}>{saved?.hasApiKey ? "已连接" : "未配置"}</Tag>
                            </div>
                            <div className="space-y-3">
                                <label className="block space-y-1.5">
                                    <span className="text-xs font-medium text-stone-700 dark:text-stone-200">New API URL</span>
                                    <Input value={draft.baseUrl} maxLength={500} placeholder="https://example.com" onChange={(event) => updateDraft(key, { baseUrl: event.target.value })} />
                                </label>
                                <label className="block space-y-1.5">
                                    <span className="text-xs font-medium text-stone-700 dark:text-stone-200">New API Key</span>
                                    <Input.Password
                                        value={draft.apiKey}
                                        maxLength={4000}
                                        autoComplete="new-password"
                                        placeholder={saved?.hasApiKey ? "已安全保存，留空可继续使用" : "sk-..."}
                                        onChange={(event) => updateDraft(key, { apiKey: event.target.value })}
                                    />
                                </label>
                            </div>
                            {saved ? (
                                <div className="mt-3 flex flex-wrap gap-1.5">
                                    <Tag>{saved.models.length} 个模型</Tag>
                                    {Object.values(saved.modelCapabilities).filter((capability) => capability === key).length ? <Tag color="blue">能力匹配</Tag> : <Tag color="orange">未发现对应模型</Tag>}
                                </div>
                            ) : null}
                        </section>
                    );
                })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button type="primary" className={profilePrimaryButtonClass} icon={<Save className="size-4" />} loading={saving} disabled={loading} onClick={() => void saveConfig()}>
                    验证并保存
                </Button>
                <Button className={profileSecondaryButtonClass} icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadConfig()}>
                    刷新目录
                </Button>
                {config?.hasApiKey ? (
                    <Button danger className={profileDangerButtonClass} icon={<Trash2 className="size-4" />} loading={clearing} onClick={clearConfig}>
                        清除全部
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
