export function dmEndpointRefusal(name: string): string {
  return `Cannot DM "${name}": this mesh endpoint does not read direct messages. Use cotal endpoints, /who, or the console roster pane to find a DM-capable peer.`;
}
