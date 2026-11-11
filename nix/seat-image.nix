# The Cotal seat image: one OCI image carrying the Cotal runtime and its Node runtime.
#
# Build: nix build --file nix/seat-image.nix --argstr runtimeDir <dir> --out-link result
# Load:  ./result | docker load
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
    # Same dangling-link cleanup as nix/release.nix: the assembler leaves workspace links to
    # members it does not copy. The fixup still guards every other link.
    find $out/lib/cotal -xtype l -delete
  '';

  cotal = pkgs.writeShellScriptBin "cotal" ''
    exec ${pkgs.nodejs_24}/bin/node ${runtime}/lib/cotal/cotal-ai/dist/cotal.js "$@"
  '';

  passwd = pkgs.runCommand "passwd" { } ''
    mkdir -p $out/etc
    printf '%s\n' 'root:x:0:0:root:/root:/bin/false' '${user}:x:${toString uid}:${toString uid}::${home}:/bin/false' > $out/etc/passwd
    printf '%s\n' 'root:x:0:' '${user}:x:${toString uid}:' > $out/etc/group
  '';
in
{
  seatImage = pkgs.dockerTools.streamLayeredImage {
    name = "cotal-seat";
    tag = "seat";
    contents = [
      cotal
      pkgs.nodejs_24
      pkgs.cacert
      passwd
    ];
    extraCommands = ''
      mkdir -p tmp
      chmod 1777 tmp
    '';
    fakeRootCommands = ''
      mkdir -p .${home}
      chown ${toString uid}:${toString uid} .${home}
    '';
    config = {
      User = "${toString uid}:${toString uid}";
      Env = [
        "HOME=${home}"
        "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      ];
      Entrypoint = [ "${cotal}/bin/cotal" ];
      Cmd = [ "--version" ];
    };
  };
}
