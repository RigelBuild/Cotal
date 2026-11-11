# The `cotal` CLI from the prebuilt runtime tarball that rigel-release publishes.
# Nothing is compiled: fetchurl pins the tarball by hash, and the install keeps the
# tree layout the release assembler writes (.github/workflows/rigel-release.yml).
{ pkgs }:
let
  inherit (pkgs) lib;
  release = lib.importJSON ./release.json;
  system = pkgs.stdenv.hostPlatform.system;
  asset = release.assets.${system};
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

    makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/cotal" \
      --add-flags "$out/lib/cotal/cotal-ai/dist/cotal.js"

    runHook postInstall
  '';

  meta = {
    description = "Cotal mesh CLI and built-in extension packages from the rigel-release runtime tarball";
    homepage = "https://github.com/${release.repo}";
    license = lib.licenses.asl20;
    mainProgram = "cotal";
    platforms = [ system ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
