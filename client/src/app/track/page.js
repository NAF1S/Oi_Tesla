import { PaymentPanel } from "@/components/payment/payment-panel";
import { RideTracker } from "@/components/passenger/ride-tracker";
import { Heading, PageShell } from "@/components/ui";
import { getCurrentRide } from "@/lib/passenger-api";
import { readCookieHeader, requirePassenger } from "@/lib/session";

export const metadata = { title: "Your ride — TeslaB" };

/**
 * Tracking the passenger's current ride.
 *
 * The first ride is read **on the server**, with the request's own cookie, and
 * handed to the tracker as its initial value. That is worth doing even though the
 * component polls anyway: it means the page arrives with the ride already on it,
 * instead of a spinner that lasts until the first poll returns.
 *
 * A read that fails is passed on as "no ride yet" rather than thrown. The tracker
 * asks again immediately on mount and has an error state of its own; a server-side
 * exception here would replace a screen that can explain itself with a blank page.
 *
 * There is no redirect when there is no active ride. A passenger whose ride just
 * ended should see that it ended — not be bounced to the request screen, which is
 * where the "request another ride" button on that very message goes.
 */
export default async function TrackPage() {
  await requirePassenger({ redirectTo: "/track" });

  let ride = null;
  try {
    ride = await getCurrentRide({ cookie: await readCookieHeader() });
  } catch {
    // The tracker's first poll will surface it.
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <Heading level={1} description="This screen refreshes itself while your ride is active.">
        Your ride
      </Heading>
      <RideTracker initialRide={ride} />
      {/*
        TeslaPay sits below the tracker and reads only the passenger's own
        payments, so it needs nothing from the ride above it. That also means it
        is here for the whole visit rather than appearing with the ride: a fare
        left unsettled from an earlier journey is exactly as payable now as it was
        when the car stopped.
      */}
      <PaymentPanel />
    </PageShell>
  );
}
