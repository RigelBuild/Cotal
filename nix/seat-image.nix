# The Cotal seat image: one OCI image carrying the Cotal runtime and its Node runtime.
#
# Build: nix build --file nix/seat-image.nix --argstr runtimeDir <dir> --out-link result
# Load:  ./result > seat-image.tar && docker load -i seat-image.tar   (CI pushes it with crane)
#
# `runtimeDir` is the runtime tree that rigel-release.yml assembles: a `cotal/` directory
# holding bin, extensions, implementations, packages, examples, node_modules, package.json.
#
# Boundary: this file holds one image attribute, `seatImage`. Its contents and config are the
# only place the image changes. Other layers extend `contents` and `config` here; they do
# not add a second image attribute.
{
  runtimeDir,
  pkgs ? import (fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/ac588ef1c914865dad517b337ea0eb9694a4021c.tar.gz";
    sha256 = "sha256-XuAV2cUwaod3Bt4XFVqiXz3v1w2ex16W6Sv4S7EWres=";
  }) { system = builtins.currentSystem; },
}:
let
  # Fixed non-root UID. The runtime writes only under its own home directory.
  uid = 10001;
  user = "cotal";
  home = "/home/${user}";

  # Copy the runtime tree into the store so the builder can read it.
  runtimeSrc = builtins.path {
    path = /. + runtimeDir;
    name = "cotal-runtime-src";
  };

  runtime = pkgs.runCommand "cotal-runtime" { } ''
    mkdir -p $out/lib
    cp -a ${runtimeSrc} $out/lib/cotal
    chmod -R u+w $out/lib/cotal
    # The assembler leaves workspace links to members it does not copy. Delete those so the
    # fixup only sees real links; every other dangling link still fails the build.
    find $out/lib/cotal -xtype l -delete
  '';

  # Every -dev output among nodejs-slim_24's build inputs, plus bash. Derived rather than kept by
  # hand, so a nixpkgs bump that adds a -dev input reaches the closure check below.
  unwantedRefs =
    map (p: p.dev) (builtins.filter (p: p ? dev) pkgs.nodejs-slim_24.buildInputs)
    ++ [ pkgs.bashNonInteractive ];
  stripArgs = pkgs.lib.concatMapStringsSep " " (p: "-t ${p}") (unwantedRefs ++ [ pkgs.nodejs-slim_24 pkgs.uvwasi ]);
  # uvwasi's propagated-build-inputs names libuv-dev. bin/node loads uvwasi's lib through RUNPATH,
  # so point RUNPATH at a copy without that file. The copy keeps the store name, so the RUNPATH
  # length is unchanged and patchelf rewrites it in place.
  uvwasiTrimmed = pkgs.runCommand pkgs.uvwasi.name { disallowedRequisites = [ pkgs.libuv.dev ]; } ''
    cp -R ${pkgs.uvwasi} $out
    chmod -R u+w $out
    find $out -type f -exec ${pkgs.removeReferencesTo}/bin/remove-references-to -t ${pkgs.uvwasi} -t ${pkgs.libuv.dev} {} +
  '';
  # Strips node's own store path too: bin/node and config.gypi embed it, and it pulls the unwanted
  # outputs back in. Fails closed: refuses to continue if uvwasi is not in RUNPATH, and smoke-runs
  # the result so a broken RUNPATH or missing Intl data fails the build.
  nodeTrimmed = pkgs.runCommand "nodejs-slim-24-trimmed" {
    nativeBuildInputs = [ pkgs.patchelf ];
    disallowedRequisites = unwantedRefs ++ [ pkgs.nodejs-slim_24 pkgs.uvwasi ];
  } ''
    cp -R ${pkgs.nodejs-slim_24} $out
    chmod -R u+w $out
    old="${pkgs.uvwasi}"
    new="${uvwasiTrimmed}"
    rpath="$(patchelf --print-rpath $out/bin/node)"
    case ":$rpath:" in
      *":$old/lib:"*) ;;
      *)
        echo "error: $old/lib is not in the node RUNPATH; the uvwasi swap would do nothing" >&2
        exit 1
        ;;
    esac
    patchelf --set-rpath "''${rpath//"$old"/"$new"}" $out/bin/node
    find $out -type f -exec ${pkgs.removeReferencesTo}/bin/remove-references-to ${stripArgs} {} +
    $out/bin/node -e '
      const zlib = require("zlib");
      const crypto = require("crypto");
      if (new Intl.NumberFormat("de-DE").format(1234.5) !== "1.234,5") throw new Error("Intl de-DE");
      if (zlib.gunzipSync(zlib.gzipSync("ok")).toString() !== "ok") throw new Error("zlib");
      crypto.createHash("sha256").update("ok").digest("hex");
    '
  '';
  # Checks the whole image closure, not only node: a -dev output or bash fails the image build even
  # if a disallowedRequisites list missed it. The pattern is -bash- because store paths start with a hash.
  imageClosure = pkgs.closureInfo { rootPaths = [ nodeTrimmed runtime etcFiles ]; };
  imageContents = pkgs.runCommand "seat-image-contents" { } ''
    if grep -E -- '-dev($|-)|-bash-' ${imageClosure}/store-paths; then
      echo "error: the seat image closure holds a -dev output or bash" >&2
      exit 1
    fi
    touch $out
  '';

  # The entrypoint is node running the runtime's cotal.js directly. No shell wrapper, so no bash
  # is in the image.
  cotalEntry = "${runtime}/lib/cotal/cotal-ai/dist/cotal.js";
  # passwd, group and the CA bundle are written as real files in the image root. A store-path
  # entry in `contents` makes /etc a link into /nix/store, which containerd refuses to mount.
  etcFiles = pkgs.runCommand "etc-files" { } ''
    mkdir -p $out
    printf '%s\n' 'root:x:0:0:root:/root:/bin/false' '${user}:x:${toString uid}:${toString uid}::${home}:/bin/false' > $out/passwd
    printf '%s\n' 'root:x:0:' '${user}:x:${toString uid}:' > $out/group
    cp ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt $out/ca-bundle.crt
  '';
in
{
  seatImage = pkgs.dockerTools.streamLayeredImage {
    name = "cotal-seat";
    tag = "seat";
    contents = [
      nodeTrimmed
    ];
    extraCommands = ''
      # Build-time guard: realise the contents check, so a regression fails this image build.
      : ${imageContents}
      mkdir -p tmp
      chmod 1777 tmp
    '';
    fakeRootCommands = ''
      mkdir -p .${home} etc
      cp ${etcFiles}/passwd etc/passwd
      cp ${etcFiles}/group etc/group
      cp ${etcFiles}/ca-bundle.crt etc/ca-bundle.crt
      chmod 0644 etc/passwd etc/group etc/ca-bundle.crt
      chown ${toString uid}:${toString uid} .${home}
    '';
    config = {
      User = "${toString uid}:${toString uid}";
      Env = [
        "HOME=${home}"
        "SSL_CERT_FILE=/etc/ca-bundle.crt"
      ];
      Entrypoint = [
        "${nodeTrimmed}/bin/node"
        cotalEntry
      ];
      Cmd = [ "--version" ];
    };
  };
}
