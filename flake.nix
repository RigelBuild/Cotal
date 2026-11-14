{
  description = "Cotal runtime: the prebuilt rigel-release tarball, pinned by hash";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      lib = nixpkgs.lib;
      release = lib.importJSON ./nix/release.json;
      # Only systems with a published runtime asset in nix/release.json get a package.
      systems = builtins.attrNames release.assets;
      cotalFor = pkgs: import ./nix/release.nix { inherit pkgs; };
    in
    {
      packages = lib.genAttrs systems (
        system:
        let
          cotal = cotalFor nixpkgs.legacyPackages.${system};
        in
        {
          inherit cotal;
          default = cotal;
        }
      );

      overlays.default = final: _prev: {
        cotal = cotalFor final;
      };
    };
}
