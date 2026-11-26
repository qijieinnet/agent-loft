async function appRegistrations() {
  if (!navigator.serviceWorker) return [];
  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
  return registrations.filter(registration => {
    const scope = new URL(registration.scope).pathname;
    const script = registration.active && new URL(registration.active.scriptURL).pathname;
    return scope === "/" && script === "/sw.js";
  });
}

export async function dismissLocalNotifications(message) {
  for (const registration of await appRegistrations()) registration.active?.postMessage(message);
}

// Release the current origin’s device, including workbench subscriptions created
// before the server started binding them to a login session.
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
