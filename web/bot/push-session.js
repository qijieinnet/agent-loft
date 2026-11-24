async function appRegistrations() {
  if (!navigator.serviceWorker) return [];
  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
  return registrations.filter(registration => {
    const scope = new URL(registration.scope).pathname;
    const script = registration.active && new URL(registration.active.scriptURL).pathname;
    return (scope === "/" && script === "/sw.js") || (scope === "/bot/" && script === "/bot/sw.js");
  });
}

export async function dismissLocalNotifications(message) {
  for (const registration of await appRegistrations()) registration.active?.postMessage(message);
}

// Both web apps use the same login cookie. A sign-out also releases this browser's
// pre-Bot workbench subscription, which older servers did not bind to a session.
export async function releaseLocalPushDevices() {
  const endpoints = await Promise.all((await appRegistrations()).map(async registration => {
    registration.active.postMessage({ type: "session-ended" });
    const subscription = await registration.pushManager?.getSubscription().catch(() => null);
    if (!subscription) return;
    await subscription.unsubscribe().catch(() => {});
    return subscription.endpoint;
  }));
  return endpoints.filter(Boolean);
}
