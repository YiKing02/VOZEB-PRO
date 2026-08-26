import { NextResponse } from "next/server";

import { DEFAULT_SITE_SETTINGS, getAuthSettings } from "@/lib/auth/store";
import { getCurrentUser, serializeCurrentUser, serializePublicSettings } from "@/lib/auth/session";
import { getInstallStatus } from "@/lib/server/install-status";
import { getUserGenerationSettings } from "@/lib/server/user-newapi-config";

export const runtime = "nodejs";

export async function GET() {
    let user = null;
    try {
        user = await getCurrentUser();
    } catch {
        user = null;
    }

    if (user) {
        try {
            const settings = await getUserGenerationSettings(await getAuthSettings(), user.id);
            return NextResponse.json({
                user: serializeCurrentUser(user),
                settings: serializePublicSettings(settings),
                install: { ready: true, firstAdminRequired: false, database: { healthy: true, schemaReady: true } },
            });
        } catch {
            user = null;
        }
    }

    const install = await getInstallStatus();
    if (!install.database.healthy || !install.database.schemaReady) {
        return NextResponse.json({ user: null, settings: { site: DEFAULT_SITE_SETTINGS }, install });
    }

    const settings = await getAuthSettings();
    return NextResponse.json({
        user: null,
        settings: serializePublicSettings(settings),
        install,
    });
}
