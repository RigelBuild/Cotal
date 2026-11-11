# The crane binary the seat-image publisher uses to push and tag by digest.
#
# It comes from the same nixpkgs pin as nix/seat-image.nix, so one revision governs both.
# Build: nix build --file nix/crane.nix --no-link --print-out-paths
{
  pkgs ? import (fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/ac588ef1c914865dad517b337ea0eb9694a4021c.tar.gz";
    sha256 = "sha256-XuAV2cUwaod3Bt4XFVqiXz3v1w2ex16W6Sv4S7EWres=";
  }) { system = builtins.currentSystem; },
}:
pkgs.crane
