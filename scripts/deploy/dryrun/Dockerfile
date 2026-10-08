# Dry-run stand-in for a fresh Ubuntu 24.04 server: systemd as PID 1, nothing else. Built natively
# for the host's arch (jrei/systemd-ubuntu is amd64 only, and systemd 255's executor does not start
# services under Rosetta emulation on an Apple silicon Mac). Used only by scripts/deploy/dryrun.sh.
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
LABEL lineage=1
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /lib/systemd/system/multi-user.target.wants/* /etc/systemd/system/*.wants/* /lib/systemd/system/sockets.target.wants/*udev* \
    /lib/systemd/system/sockets.target.wants/*initctl* /lib/systemd/system/sysinit.target.wants/systemd-tmpfiles-setup* /lib/systemd/system/systemd-update-utmp*
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
