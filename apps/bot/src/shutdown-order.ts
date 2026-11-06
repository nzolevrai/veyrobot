/** Keep the single-instance lease until Discord has finished closing its Gateway connection. */
export async function destroyClientBeforeReleasingLease(
  client: { destroy(): Promise<void> },
  releaseLease: () => Promise<void>,
): Promise<void> {
  await client.destroy();
  await releaseLease();
}
