export function dmEndpointRefusal(name: string): string {
  return `Cannot DM "${name}": this mesh endpoint does not read direct messages (for example, the manager process). Use cotal_roster to find an agent.`;
}
