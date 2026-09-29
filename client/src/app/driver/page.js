import { DriverConsole } from "@/components/driver/driver-console";
import { EarningsPanel } from "@/components/payment/payment-panel";
import { Heading, PageShell } from "@/components/ui";
import { getAvailability, getCurrentPool, listOffers } from "@/lib/driver-api";
import { listServicePoints } from "@/lib/location-api";
import { DRIVER_HOME, readCookieHeader, requireDriver } from "@/lib/session";

export const metadata = { title: "Driver console — TeslaB" };

/**
 * The driver's one screen, for this milestone.
 *
 * The guard runs first, so a passenger who wanders here is sent to their own home
 * rather than shown an empty console — and so nobody sees the shape of a driver's
 * screen before signing in as one. It is not the authorization: the API checks the
 * role on every call regardless.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PAGE READS EVERYTHING UP FRONT
 * ---------------------------------------------------------------------------
 * Four reads on the server, in parallel, so the console's first paint is the real
 * state instead of four spinners. The client then polls to keep it current, which
 * is what matters here — an offer can arrive at any second, and none of these
 * values is cacheable.
 *
 * A failure is deliberately **not** swallowed. The availability read is what the
 * entire screen is about, and an unreachable API means there is nothing honest to
 * render; the guard above has already made the same call, since it asks the API
 * who is signed in. What the console *does* handle is a failure that happens
 * later, while the driver is watching: that keeps the last good state and says so.
 */
export default async function DriverPage() {
  const user = await requireDriver({ redirectTo: DRIVER_HOME });
  const cookie = await readCookieHeader();

  const [availability, offers, pool, servicePoints] = await Promise.all([
    getAvailability({ cookie }),
    listOffers({ status: "PENDING", cookie }),
    getCurrentPool({ cookie }),
    // Public reference data, and the driver needs it to come online at a place.
    listServicePoints(),
  ]);

  return (
    <PageShell className="flex flex-col gap-6">
      <Heading
        level={1}
        description={`Signed in as ${user.name}. Offers come to you, one at a time, and they expire.`}
      >
        Driver console
      </Heading>

      <DriverConsole initial={{ availability, offers, pool, servicePoints }} />

      {/*
        TeslaPay, from the driver's side of the same table. It is deliberately
        its own panel and its own fetch rather than part of the console's poll:
        money does not change on a five-second heartbeat, and folding an earnings
        read into the dispatch loop would make every poll pay for it.
      */}
      <EarningsPanel />
    </PageShell>
  );
}
