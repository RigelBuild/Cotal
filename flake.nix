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
      # Development shells are useful on hosts without a published runtime asset.
      devShellSystems = [ "x86_64-linux" "aarch64-linux" ];
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

      devShells = lib.genAttrs devShellSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          hk = pkgs.stdenvNoCC.mkDerivation {
            pname = "hk";
            version = "2.11.0";
            src = pkgs.fetchurl {
              url =
                "https://github.com/jdx/hk/releases/download/v2.11.0/hk-${if system == "x86_64-linux" then "x86_64" else "aarch64"}-unknown-linux-gnu.tar.gz";
              hash =
                if system == "x86_64-linux" then
                  "sha256-pGHrl9+OYMREfR/ap0o9MVmNeroNemjO660P8EBcO1s="
                else
                  "sha256-Scu6RBWcF6dgMZzPzKD+Sgf6cW8hfBV+pzSSMWC4rLk=";
            };
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/bin
              tar -xzf $src -C $out/bin hk
            '';
          };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [ nodejs_24 pnpm pkl hk ];
          };
        }
      );

      overlays.default = final: _prev: {
        cotal = cotalFor final;
      };
    };
}
