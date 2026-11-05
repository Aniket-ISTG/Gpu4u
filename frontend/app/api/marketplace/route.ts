import { MockMarketplaceProvider } from "@/lib/marketplace/mock-provider";

export async function GET() {
  const provider = new MockMarketplaceProvider();
  const offers = await provider.getOffers();

  return Response.json({
    success: true,
    source: "mock",
    offers,
  });
}