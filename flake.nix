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
      # The native seat build compiles only on Linux; hk is fetched per Linux architecture below.
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
            # Keep this in sync with hk.pkl's package:// release.
            version = "2.11.0";
            src = pkgs.fetchurl {
              url =
                "https://github.com/jdx/hk/releases/download/v2.11.0/hk-${if system == "x86_64-linux" then "x86_64" else "aarch64"}-unknown-linux-musl.tar.gz";
              hash =
                if system == "x86_64-linux" then
                  "sha256-7axQfk+ySKfQiFNnuH7AArBzxTC8sHyRM0hV5UxLA1I="
                else
                  "sha256-m7VzuvCTG/TM5caB3LGyvL1bybf8vQeSUqdCh2pSnfw=";
            };
            dontUnpack = true;
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/bin
              tar -xzf $src -C $out/bin hk
            '';
            meta = {
              mainProgram = "hk";
              platforms = [ "x86_64-linux" "aarch64-linux" ];
              sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
            };
          };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [ nodejs_26 pnpm pkl hk ];
          };
        }
      );

      overlays.default = final: _prev: {
        cotal = cotalFor final;
      };
    };
}
