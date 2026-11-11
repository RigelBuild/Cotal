# The `cotal` CLI from the prebuilt runtime tarball that rigel-release publishes.
# Nothing is compiled: fetchurl pins the tarball by hash, and the install keeps the
# tree layout the release assembler writes (.github/workflows/rigel-release.yml).
{ pkgs }:
let
  inherit (pkgs) lib;
  release = lib.importJSON ./release.json;
  system = pkgs.stdenv.hostPlatform.system;
  asset =
    release.assets.${system}
      or (throw "cotal: no published runtime asset for ${system} in nix/release.json");
  assetName = "cotal-runtime-${asset.platform}.tar.gz";
in
assert lib.assertMsg (lib.hasPrefix "rigel-v${release.version}-" release.tag)
  "nix/release.json: tag ${release.tag} does not carry version ${release.version}";
pkgs.stdenvNoCC.mkDerivation {
  pname = "cotal";
  inherit (release) version;

  src = pkgs.fetchurl {
    url = "https://github.com/${release.repo}/releases/download/${release.tag}/${assetName}";
    inherit (asset) hash;
  };

  # The archive has one top-level directory, `cotal/`, which holds the runtime tree.
  sourceRoot = "cotal";

  nativeBuildInputs = [ pkgs.makeWrapper ];
  dontBuild = true;
  # Stripping would rewrite the prebuilt .node files, so keep them as released.
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib" "$out/bin"
    cp -a . "$out/lib/cotal"

    # The release assembler copies only bin, extensions, implementations, packages and examples
    # (.github/workflows/rigel-release.yml). The pnpm workspace links that point at the other
    # members (desktop, tools/docs-content) therefore dangle in the tarball. nixpkgs' noBrokenSymlinks
    # fixup fails the build on them, and they are unused at runtime, so drop them. Do not disable
    # the fixup: it still guards every other link.
    find "$out/lib/cotal" -xtype l -delete

    makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/cotal" \
      --add-flags "$out/lib/cotal/cotal-ai/dist/cotal.js"

    runHook postInstall
  '';

  meta = {
    description = "Cotal mesh CLI and built-in extension packages from the rigel-release runtime tarball";
    homepage = "https://github.com/${release.repo}";
    license = lib.licenses.asl20;
    mainProgram = "cotal";
    platforms = builtins.attrNames release.assets;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
