import { getMarketplaceProvider } from "../marketplace/aquanode-provider.ts";
import type { MarketplaceProvider } from "../../lib/marketplace/types.ts";

/** GET /api/marketplace: live offers from Aquanode, normalized, with data-path details. */
export async function handleGetMarketplace(
  provider: MarketplaceProvider = getMarketplaceProvider(),
): Promise<Response> {
  try {
    const snapshot = await provider.getSnapshot();
    return Response.json({ success: true, ...snapshot });
  } catch {
    return Response.json(
      { success: false, error: "The GPU marketplace is unavailable right now. Please try again shortly." },
      { status: 502 },
    );
  }
}
