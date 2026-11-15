# Kali Linux Arsenal — Capability & Tool Knowledge Database

> **Edition:** Seed catalogue v1.0  
> **Prepared:** 2026-11-15  
> **Status:** Curated 90-profile seed database; not an exhaustive or live-verified Kali package inventory.  
> **Intended use:** Knowledge retrieval and planning for authorized security assessment, education, defensive engineering, and local lab work.

## Important catalogue integrity note

This document reconstructs the previously defined **90 seed profiles**, grouped into **21 capability families**. The 90 entries are curated profiles, **not** a claim that Kali contains only 90 tools, nor a claim that every package name, alias, binary, or version has been verified against the live Kali repositories on the date above. Kali's package catalogue changes over time. Package names and executable names can differ. Treat package mappings as `VERIFY_ON_TARGET` before installation or execution.

The earlier planning notes also referenced **36 Kali metapackages**. This edition does not invent a 36-item metapackage-to-tool mapping: that mapping requires a versioned package-catalogue capture.

## Contents

1. Purpose and design
2. Architecture and trust boundaries
3. Capability family index
4. Canonical tool profile schema
5. Tool profiles
6. Research methodology
7. Authorization and impact model
8. Evidence quality and reporting
9. Environment availability and package verification
10. Catalogue verification and expansion
11. Marshmallow / agent integration contract
12. Glossary
13. Manifest

---

## Purpose and design

The database maps **goals → capabilities → candidate implementations → verified environment availability → authorization → approved plan**. It is deliberately not a command cookbook. It helps an agent understand what a tool is for, what information it consumes and produces, what risks it introduces, and what must be checked before use.

### Core principles

- **Goal ≠ capability ≠ tool.** A goal is an outcome; a capability is a reusable concept; a tool is one possible implementation.
- **Discovery ≠ authorization.** Finding a tool or target never grants permission to use it.
- **Knowledge ≠ availability.** A profile does not prove the package is installed, executable, configured, or compatible.
- **Availability ≠ authorization.** An installed tool must still pass engagement scope, policy, and approval gates.
- **Evidence before claims.** A scanner alert is a lead until independently validated.
- **Prefer minimum-impact verification.** Use read-only and non-destructive checks where possible.
- **Preserve provenance.** Record source, time, tool/version, configuration, target scope, and evidence references.
- **Be honest about uncertainty.** Unknown values remain `NEEDS_VERIFICATION`; never invent commands or package metadata.

## Architecture and trust boundaries

```text
USER / ENGAGEMENT GOAL
        |
        v
Intent understanding and task decomposition
        |
        v
Capability search (this knowledge catalogue)
        |
        v
Candidate capability graph and dependencies
        |
        v
Environment registry (live package/binary discovery)
        |
        v
Identity, version, path, and availability verification
        |
        v
Scope + authorization + policy gate
        |
        v
Human approval where required
        |
        v
Bounded execution through approved adapters
        |
        v
Result normalization, independent validation, evidence
        |
        v
Report + lessons learned
```

**Hard boundary:** this document is a read-mostly knowledge/index layer. It must never directly execute tools, select arbitrary targets, grant scope, bypass approval, or store live credentials. The enforcement layer remains authoritative.

---

## Capability family index

| ID | Family | Purpose |
|---|---|---|
| `01` | **Asset discovery & OSINT** | Discover publicly exposed, organization-associated assets using approved sources and bounded collection. |
| `02` | **DNS & domain intelligence** | Inspect DNS records, naming relationships, and domain configuration. |
| `03` | **Network discovery & mapping** | Map authorized network ranges, hosts, routes, and exposed services. |
| `04` | **Port & service identification** | Identify reachable ports and characterize services without assuming a vulnerability. |
| `05` | **Web application assessment** | Review web application behavior, configuration, and common security controls. |
| `06` | **API assessment** | Inspect API structure, authentication, authorization, schemas, and response behavior. |
| `07` | **Content & directory discovery** | Identify publicly reachable web content and resources within explicit scope. |
| `08` | **TLS & cryptographic configuration** | Assess certificates, protocol negotiation, and cryptographic configuration. |
| `09` | **Vulnerability identification** | Correlate observed software/configuration with known weaknesses and validate safely. |
| `10` | **Fuzzing & input robustness** | Test parser and input-handling behavior using controlled, non-destructive cases. |
| `11` | **Authentication & identity** | Assess authentication flows, identity configuration, and account-security controls. |
| `12` | **Password auditing** | Evaluate password storage and authentication resilience using authorized test material. |
| `13` | **Wireless security** | Assess wireless configuration and security only on networks explicitly owned or authorized. |
| `14` | **Packet capture & network analysis** | Capture or inspect authorized network traffic and protocol exchanges. |
| `15` | **Traffic interception & proxying** | Inspect application traffic in a controlled test environment with explicit authorization. |
| `16` | **Source code & static analysis** | Identify security-relevant patterns in source code and dependencies. |
| `17` | **Reverse engineering & binary analysis** | Inspect authorized binaries, firmware, and executable behavior. |
| `18` | **Mobile application security** | Assess Android/iOS application packages and their local security properties. |
| `19` | **Database & data-service assessment** | Review database exposure, configuration, and access controls within scope. |
| `20` | **Forensics & incident response** | Preserve, parse, and analyze digital evidence without altering originals. |
| `21` | **Reporting & evidence utilities** | Normalize outputs, preserve evidence, and produce reproducible assessment records. |

## Canonical tool profile schema

Every profile uses these fields:

- **Canonical name / package:** human-facing tool name and likely Kali package mapping. Verify package identity on the target release.
- **Family:** primary capability family; secondary capabilities may also apply.
- **Description / primary use:** concise purpose and appropriate assessment context.
- **Typical inputs / outputs:** data classes, not guaranteed exact CLI flags.
- **Execution characteristics:** passive, active, local, offline, or cloud/API behavior.
- **Impact:** rough operational risk, not a vulnerability severity score.
- **Availability:** `UNKNOWN` until a live environment registry verifies package, executable, version, and identity.

### Impact scale

| Level | Meaning |
|---|---|
| Low | Local/passive inspection or low-volume read-only queries; still subject to policy. |
| Medium | Sends traffic or accesses a service; may create logs or modest operational load. |
| High | Can generate substantial traffic, alter state, authenticate repeatedly, intercept traffic, or affect availability. Requires strict controls and explicit approval. |

---

## Tool profiles

### 01. Amass

- **Canonical name:** `Amass`
- **Likely Kali package:** `amass` — `VERIFY_ON_TARGET`
- **Primary family:** `01 — Asset discovery & OSINT`
- **Description:** Attack-surface mapping and asset-discovery framework.
- **Primary use cases:** Authorized domain and subdomain discovery; relationship mapping.
- **Typical inputs:** Approved domains, organization identifiers, passive-source settings.
- **Typical outputs:** Asset names, DNS relationships, source observations.
- **Execution characteristics:** Passive or mixed
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 02. theHarvester

- **Canonical name:** `theHarvester`
- **Likely Kali package:** `theharvester` — `VERIFY_ON_TARGET`
- **Primary family:** `01 — Asset discovery & OSINT`
- **Description:** Collects publicly available names, email addresses, hosts, and related metadata.
- **Primary use cases:** Passive OSINT collection for an approved organization.
- **Typical inputs:** Approved domain, permitted data sources.
- **Typical outputs:** Collected identifiers and source references.
- **Execution characteristics:** Primarily passive
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 03. SpiderFoot

- **Canonical name:** `SpiderFoot`
- **Likely Kali package:** `spiderfoot` — `VERIFY_ON_TARGET`
- **Primary family:** `01 — Asset discovery & OSINT`
- **Description:** Automated OSINT platform with modular data-source integrations.
- **Primary use cases:** Correlate public indicators and map an approved external footprint.
- **Typical inputs:** Approved seed domain, IP, email, or organization.
- **Typical outputs:** Linked observations, entities, and provenance.
- **Execution characteristics:** Passive or mixed
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 04. Recon-ng

- **Canonical name:** `Recon-ng`
- **Likely Kali package:** `recon-ng` — `VERIFY_ON_TARGET`
- **Primary family:** `01 — Asset discovery & OSINT`
- **Description:** Modular reconnaissance framework for structured OSINT workflows.
- **Primary use cases:** Organize authorized reconnaissance and source-backed findings.
- **Typical inputs:** Workspace, approved seed identifiers, configured modules.
- **Typical outputs:** Structured records and module output.
- **Execution characteristics:** Passive or mixed
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 05. Maltego

- **Canonical name:** `Maltego`
- **Likely Kali package:** `maltego` — `VERIFY_ON_TARGET`
- **Primary family:** `01 — Asset discovery & OSINT`
- **Description:** Visual link-analysis platform for entity and relationship investigation.
- **Primary use cases:** Explore relationships among public entities and indicators.
- **Typical inputs:** Entities and authorized data-source results.
- **Typical outputs:** Relationship graph and transform results.
- **Execution characteristics:** Primarily passive
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 06. Photon

- **Canonical name:** `Photon`
- **Likely Kali package:** `photon` — `VERIFY_ON_TARGET`
- **Primary family:** `01 — Asset discovery & OSINT`
- **Description:** Web reconnaissance crawler for extracting URLs, files, and metadata.
- **Primary use cases:** Collect public web references from an approved target.
- **Typical inputs:** Approved website URL and crawl limits.
- **Typical outputs:** URLs, files, endpoints, and metadata.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 07. Sublist3r

- **Canonical name:** `Sublist3r`
- **Likely Kali package:** `sublist3r` — `VERIFY_ON_TARGET`
- **Primary family:** `01 — Asset discovery & OSINT`
- **Description:** Subdomain enumeration utility using public sources and DNS.
- **Primary use cases:** Discover candidate subdomains for approved domains.
- **Typical inputs:** Approved domain and source configuration.
- **Typical outputs:** Candidate subdomain list.
- **Execution characteristics:** Passive or mixed
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 08. dnsenum

- **Canonical name:** `dnsenum`
- **Likely Kali package:** `dnsenum` — `VERIFY_ON_TARGET`
- **Primary family:** `02 — DNS & domain intelligence`
- **Description:** DNS enumeration utility for collecting domain and DNS information.
- **Primary use cases:** Review DNS records and authorized domain configuration.
- **Typical inputs:** Approved domain and resolver settings.
- **Typical outputs:** DNS records and related hostnames.
- **Execution characteristics:** Mixed
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 09. dnsrecon

- **Canonical name:** `dnsrecon`
- **Likely Kali package:** `dnsrecon` — `VERIFY_ON_TARGET`
- **Primary family:** `02 — DNS & domain intelligence`
- **Description:** DNS reconnaissance and record-enumeration framework.
- **Primary use cases:** Inspect DNS records, zone configuration, and name resolution.
- **Typical inputs:** Approved domain and DNS server.
- **Typical outputs:** Record sets and DNS observations.
- **Execution characteristics:** Mixed
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 10. fierce

- **Canonical name:** `fierce`
- **Likely Kali package:** `fierce` — `VERIFY_ON_TARGET`
- **Primary family:** `02 — DNS & domain intelligence`
- **Description:** DNS reconnaissance tool for locating related hosts and misconfigurations.
- **Primary use cases:** Bounded DNS discovery for an approved domain.
- **Typical inputs:** Approved domain and resolver.
- **Typical outputs:** Candidate hostnames and DNS results.
- **Execution characteristics:** Active DNS queries
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 11. whois

- **Canonical name:** `whois`
- **Likely Kali package:** `whois` — `VERIFY_ON_TARGET`
- **Primary family:** `02 — DNS & domain intelligence`
- **Description:** Queries registration data for domains and IP allocations.
- **Primary use cases:** Review public registration and allocation metadata.
- **Typical inputs:** Domain or IP address.
- **Typical outputs:** Registration records, where available.
- **Execution characteristics:** Passive
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 12. dig

- **Canonical name:** `dig`
- **Likely Kali package:** `bind9-dnsutils` — `VERIFY_ON_TARGET`
- **Primary family:** `02 — DNS & domain intelligence`
- **Description:** Flexible DNS query utility.
- **Primary use cases:** Query specific record types and troubleshoot DNS behavior.
- **Typical inputs:** Hostname, record type, resolver.
- **Typical outputs:** DNS answer, authority, and timing details.
- **Execution characteristics:** Passive query
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 13. Nmap

- **Canonical name:** `Nmap`
- **Likely Kali package:** `nmap` — `VERIFY_ON_TARGET`
- **Primary family:** `03 — Network discovery & mapping`
- **Description:** Network discovery and security auditing utility.
- **Primary use cases:** Authorized host discovery, inventory, and service mapping.
- **Typical inputs:** Approved IP, hostname, or CIDR; explicit scan limits.
- **Typical outputs:** Host, port, service, and script observations.
- **Execution characteristics:** Active network traffic
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 14. Masscan

- **Canonical name:** `Masscan`
- **Likely Kali package:** `masscan` — `VERIFY_ON_TARGET`
- **Primary family:** `03 — Network discovery & mapping`
- **Description:** High-speed TCP port scanner.
- **Primary use cases:** Inventory selected ports across explicitly authorized ranges.
- **Typical inputs:** Approved CIDR and narrowly defined ports/rate.
- **Typical outputs:** Open-port observations.
- **Execution characteristics:** Active high-volume traffic
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 15. netdiscover

- **Canonical name:** `netdiscover`
- **Likely Kali package:** `netdiscover` — `VERIFY_ON_TARGET`
- **Primary family:** `03 — Network discovery & mapping`
- **Description:** ARP-based local network discovery utility.
- **Primary use cases:** Identify devices on an authorized local network.
- **Typical inputs:** Authorized local interface and subnet.
- **Typical outputs:** IP/MAC observations.
- **Execution characteristics:** Active local network traffic
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 16. arp-scan

- **Canonical name:** `arp-scan`
- **Likely Kali package:** `arp-scan` — `VERIFY_ON_TARGET`
- **Primary family:** `03 — Network discovery & mapping`
- **Description:** ARP scanning tool for local Ethernet networks.
- **Primary use cases:** Inventory devices on a permitted local broadcast domain.
- **Typical inputs:** Authorized interface and address range.
- **Typical outputs:** IP/MAC/vendor observations.
- **Execution characteristics:** Active local network traffic
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 17. traceroute

- **Canonical name:** `traceroute`
- **Likely Kali package:** `traceroute` — `VERIFY_ON_TARGET`
- **Primary family:** `03 — Network discovery & mapping`
- **Description:** Displays network path characteristics toward a destination.
- **Primary use cases:** Troubleshoot routing and understand network paths.
- **Typical inputs:** Approved destination.
- **Typical outputs:** Hop sequence and timing.
- **Execution characteristics:** Active network probes
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 18. hping3

- **Canonical name:** `hping3`
- **Likely Kali package:** `hping3` — `VERIFY_ON_TARGET`
- **Primary family:** `03 — Network discovery & mapping`
- **Description:** Packet crafting and network testing utility.
- **Primary use cases:** Controlled network-path and firewall behavior diagnostics.
- **Typical inputs:** Authorized destination and carefully bounded packet parameters.
- **Typical outputs:** Packet responses and timing.
- **Execution characteristics:** Active crafted traffic
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 19. Naabu

- **Canonical name:** `Naabu`
- **Likely Kali package:** `naabu` — `VERIFY_ON_TARGET`
- **Primary family:** `04 — Port & service identification`
- **Description:** Fast port discovery tool designed for asset-assessment workflows.
- **Primary use cases:** Identify reachable TCP ports on approved assets.
- **Typical inputs:** Approved hosts and port/rate limits.
- **Typical outputs:** Port observations.
- **Execution characteristics:** Active network traffic
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 20. unicornscan

- **Canonical name:** `unicornscan`
- **Likely Kali package:** `unicornscan` — `VERIFY_ON_TARGET`
- **Primary family:** `04 — Port & service identification`
- **Description:** Asynchronous network and service discovery scanner.
- **Primary use cases:** Controlled service and port inventory.
- **Typical inputs:** Approved network targets and scan profile.
- **Typical outputs:** Port/service observations.
- **Execution characteristics:** Active network traffic
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 21. netcat

- **Canonical name:** `netcat`
- **Likely Kali package:** `netcat-openbsd` — `VERIFY_ON_TARGET`
- **Primary family:** `04 — Port & service identification`
- **Description:** General-purpose TCP/UDP connection and listener utility.
- **Primary use cases:** Connectivity checks and authorized service diagnostics.
- **Typical inputs:** Host, port, protocol, or local listener configuration.
- **Typical outputs:** Connection state and byte streams.
- **Execution characteristics:** Active connections
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 22. socat

- **Canonical name:** `socat`
- **Likely Kali package:** `socat` — `VERIFY_ON_TARGET`
- **Primary family:** `04 — Port & service identification`
- **Description:** Bidirectional data relay between sockets and other endpoints.
- **Primary use cases:** Diagnose authorized socket and protocol paths.
- **Typical inputs:** Local/remote endpoints and relay options.
- **Typical outputs:** Relayed streams and connection diagnostics.
- **Execution characteristics:** Active connections
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 23. curl

- **Canonical name:** `curl`
- **Likely Kali package:** `curl` — `VERIFY_ON_TARGET`
- **Primary family:** `05 — Web application assessment`
- **Description:** Command-line client for HTTP and numerous other protocols.
- **Primary use cases:** Inspect web responses, headers, redirects, and API behavior.
- **Typical inputs:** Approved URL, method, headers, and request body.
- **Typical outputs:** HTTP response, headers, timing, and body.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 24. Wget

- **Canonical name:** `Wget`
- **Likely Kali package:** `wget` — `VERIFY_ON_TARGET`
- **Primary family:** `05 — Web application assessment`
- **Description:** Retrieves content over HTTP, HTTPS, and FTP.
- **Primary use cases:** Fetch public resources and reproduce content retrieval.
- **Typical inputs:** Approved URL and bounded retrieval options.
- **Typical outputs:** Downloaded content and transfer metadata.
- **Execution characteristics:** Active requests
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 25. Nikto

- **Canonical name:** `Nikto`
- **Likely Kali package:** `nikto` — `VERIFY_ON_TARGET`
- **Primary family:** `05 — Web application assessment`
- **Description:** Web server scanner for known files, configurations, and exposures.
- **Primary use cases:** Check an approved web server for common configuration issues.
- **Typical inputs:** Approved base URL and scan scope.
- **Typical outputs:** Potential findings and response evidence.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 26. WhatWeb

- **Canonical name:** `WhatWeb`
- **Likely Kali package:** `whatweb` — `VERIFY_ON_TARGET`
- **Primary family:** `05 — Web application assessment`
- **Description:** Identifies web technologies and application fingerprints.
- **Primary use cases:** Technology inventory for approved web properties.
- **Typical inputs:** Approved URL or host.
- **Typical outputs:** Technology and version fingerprints.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 27. Wapiti

- **Canonical name:** `Wapiti`
- **Likely Kali package:** `wapiti` — `VERIFY_ON_TARGET`
- **Primary family:** `05 — Web application assessment`
- **Description:** Web application vulnerability scanner.
- **Primary use cases:** Perform authorized, bounded web security checks.
- **Typical inputs:** Approved URL, scope exclusions, scan policy.
- **Typical outputs:** Potential findings and request/response evidence.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 28. Arachni

- **Canonical name:** `Arachni`
- **Likely Kali package:** `arachni` — `VERIFY_ON_TARGET`
- **Primary family:** `05 — Web application assessment`
- **Description:** Web application security testing framework.
- **Primary use cases:** Assess approved web applications with controlled checks.
- **Typical inputs:** Approved application URL and policy.
- **Typical outputs:** Issue records and supporting observations.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 29. Burp Suite

- **Canonical name:** `Burp Suite`
- **Likely Kali package:** `burpsuite` — `VERIFY_ON_TARGET`
- **Primary family:** `06 — API assessment`
- **Description:** Web security testing proxy and application assessment platform.
- **Primary use cases:** Manually inspect and test authorized web application traffic.
- **Typical inputs:** Browser traffic, approved target, test account.
- **Typical outputs:** HTTP history, repeater results, findings.
- **Execution characteristics:** Active when testing; passive when observing
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 30. OWASP ZAP

- **Canonical name:** `OWASP ZAP`
- **Likely Kali package:** `zaproxy` — `VERIFY_ON_TARGET`
- **Primary family:** `06 — API assessment`
- **Description:** Web application scanner and intercepting proxy.
- **Primary use cases:** Baseline and manual testing of authorized applications.
- **Typical inputs:** Approved URL, context, and scan policy.
- **Typical outputs:** Alerts, request/response records, reports.
- **Execution characteristics:** Active when scanning
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 31. ffuf

- **Canonical name:** `ffuf`
- **Likely Kali package:** `ffuf` — `VERIFY_ON_TARGET`
- **Primary family:** `07 — Content & directory discovery`
- **Description:** Fast web fuzzer for content and parameter discovery.
- **Primary use cases:** Discover approved paths and test input handling with safe wordlists.
- **Typical inputs:** Approved URL template, bounded wordlist and rate.
- **Typical outputs:** HTTP status, size, and match observations.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 32. gobuster

- **Canonical name:** `gobuster`
- **Likely Kali package:** `gobuster` — `VERIFY_ON_TARGET`
- **Primary family:** `07 — Content & directory discovery`
- **Description:** Directory, DNS, and virtual-host discovery tool.
- **Primary use cases:** Bounded content and virtual-host discovery within scope.
- **Typical inputs:** Approved host, mode, wordlist, rate limit.
- **Typical outputs:** Candidate paths or names.
- **Execution characteristics:** Active requests
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 33. dirsearch

- **Canonical name:** `dirsearch`
- **Likely Kali package:** `dirsearch` — `VERIFY_ON_TARGET`
- **Primary family:** `07 — Content & directory discovery`
- **Description:** Web path discovery utility.
- **Primary use cases:** Identify reachable paths on approved applications.
- **Typical inputs:** Approved URL and curated wordlist.
- **Typical outputs:** Path, status, size, and response metadata.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 34. feroxbuster

- **Canonical name:** `feroxbuster`
- **Likely Kali package:** `feroxbuster` — `VERIFY_ON_TARGET`
- **Primary family:** `07 — Content & directory discovery`
- **Description:** Recursive content discovery tool.
- **Primary use cases:** Map reachable web content within explicit crawl limits.
- **Typical inputs:** Approved URL, wordlist, depth and rate limits.
- **Typical outputs:** Discovered paths and response metadata.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 35. httpx

- **Canonical name:** `httpx`
- **Likely Kali package:** `httpx-toolkit` — `VERIFY_ON_TARGET`
- **Primary family:** `04 — Port & service identification`
- **Description:** HTTP probing toolkit for identifying live web services and metadata.
- **Primary use cases:** Verify HTTP service availability and collect response metadata.
- **Typical inputs:** Approved host list and bounded probe options.
- **Typical outputs:** Status, title, server, TLS, and URL metadata.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 36. testssl.sh

- **Canonical name:** `testssl.sh`
- **Likely Kali package:** `testssl.sh` — `VERIFY_ON_TARGET`
- **Primary family:** `08 — TLS & cryptographic configuration`
- **Description:** Checks TLS/SSL protocols, ciphers, and common TLS configuration issues.
- **Primary use cases:** Assess TLS configuration on approved endpoints.
- **Typical inputs:** Approved hostname and port.
- **Typical outputs:** Protocol, cipher, certificate, and issue observations.
- **Execution characteristics:** Active TLS handshakes
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 37. sslscan

- **Canonical name:** `sslscan`
- **Likely Kali package:** `sslscan` — `VERIFY_ON_TARGET`
- **Primary family:** `08 — TLS & cryptographic configuration`
- **Description:** Examines SSL/TLS services and supported cipher suites.
- **Primary use cases:** Review TLS service configuration.
- **Typical inputs:** Approved host and port.
- **Typical outputs:** Certificate and cipher details.
- **Execution characteristics:** Active TLS handshakes
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 38. sslyze

- **Canonical name:** `sslyze`
- **Likely Kali package:** `sslyze` — `VERIFY_ON_TARGET`
- **Primary family:** `08 — TLS & cryptographic configuration`
- **Description:** Python TLS configuration analyzer.
- **Primary use cases:** Automate TLS configuration review for approved services.
- **Typical inputs:** Approved hostname and port.
- **Typical outputs:** Structured TLS assessment results.
- **Execution characteristics:** Active TLS handshakes
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 39. Greenbone/OpenVAS

- **Canonical name:** `Greenbone/OpenVAS`
- **Likely Kali package:** `gvm` — `VERIFY_ON_TARGET`
- **Primary family:** `09 — Vulnerability identification`
- **Description:** Vulnerability management platform with authenticated and unauthenticated checks.
- **Primary use cases:** Assess approved systems against known vulnerability tests.
- **Typical inputs:** Approved assets, credentials if authorized, scan policy.
- **Typical outputs:** Potential vulnerabilities with references and severity.
- **Execution characteristics:** Active scanning
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 40. Nuclei

- **Canonical name:** `Nuclei`
- **Likely Kali package:** `nuclei` — `VERIFY_ON_TARGET`
- **Primary family:** `09 — Vulnerability identification`
- **Description:** Template-driven vulnerability and exposure scanner.
- **Primary use cases:** Run reviewed, scope-matched templates against approved assets.
- **Typical inputs:** Approved URLs/hosts and vetted template set.
- **Typical outputs:** Potential findings with matched evidence.
- **Execution characteristics:** Active HTTP/network checks
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 41. Searchsploit

- **Canonical name:** `Searchsploit`
- **Likely Kali package:** `exploitdb` — `VERIFY_ON_TARGET`
- **Primary family:** `09 — Vulnerability identification`
- **Description:** Offline search interface for Exploit-DB references.
- **Primary use cases:** Research known vulnerabilities and public proof-of-concept references.
- **Typical inputs:** Product, version, CVE, or keyword.
- **Typical outputs:** Matching advisory/PoC references.
- **Execution characteristics:** Offline lookup
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 42. Lynis

- **Canonical name:** `Lynis`
- **Likely Kali package:** `lynis` — `VERIFY_ON_TARGET`
- **Primary family:** `09 — Vulnerability identification`
- **Description:** System and configuration auditing tool for Unix-like systems.
- **Primary use cases:** Audit a system the operator administers.
- **Typical inputs:** Local host and audit mode.
- **Typical outputs:** Hardening suggestions and configuration findings.
- **Execution characteristics:** Local
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 43. Nmap NSE

- **Canonical name:** `Nmap NSE`
- **Likely Kali package:** `nmap` — `VERIFY_ON_TARGET`
- **Primary family:** `09 — Vulnerability identification`
- **Description:** Nmap scripting engine for protocol-aware checks.
- **Primary use cases:** Run selected, understood scripts against approved services.
- **Typical inputs:** Approved targets and individually reviewed scripts.
- **Typical outputs:** Script observations and service metadata.
- **Execution characteristics:** Active network traffic
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 44. Wfuzz

- **Canonical name:** `Wfuzz`
- **Likely Kali package:** `wfuzz` — `VERIFY_ON_TARGET`
- **Primary family:** `10 — Fuzzing & input robustness`
- **Description:** Web application fuzzing framework.
- **Primary use cases:** Controlled input variation on approved applications.
- **Typical inputs:** Approved endpoint and safe test corpus.
- **Typical outputs:** Response differences and anomaly observations.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 45. Radamsa

- **Canonical name:** `Radamsa`
- **Likely Kali package:** `radamsa` — `VERIFY_ON_TARGET`
- **Primary family:** `10 — Fuzzing & input robustness`
- **Description:** Mutation-based test case generator.
- **Primary use cases:** Generate malformed inputs for local test harnesses.
- **Typical inputs:** Seed corpus and local parser/application.
- **Typical outputs:** Mutated test cases and crash artifacts.
- **Execution characteristics:** Local by default
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 46. AFL++

- **Canonical name:** `AFL++`
- **Likely Kali package:** `afl++` — `VERIFY_ON_TARGET`
- **Primary family:** `10 — Fuzzing & input robustness`
- **Description:** Coverage-guided fuzzer for native programs.
- **Primary use cases:** Find robustness defects in authorized local binaries.
- **Typical inputs:** Instrumented target and seed corpus.
- **Typical outputs:** Crash/hang inputs and coverage data.
- **Execution characteristics:** Local
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 47. Jazzer

- **Canonical name:** `Jazzer`
- **Likely Kali package:** `jazzer` — `VERIFY_ON_TARGET`
- **Primary family:** `10 — Fuzzing & input robustness`
- **Description:** Coverage-guided JVM fuzzing engine.
- **Primary use cases:** Fuzz Java code and libraries under test.
- **Typical inputs:** Java target, harness, seed corpus.
- **Typical outputs:** Reproducers, crashes, coverage.
- **Execution characteristics:** Local
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 48. Hydra

- **Canonical name:** `Hydra`
- **Likely Kali package:** `hydra` — `VERIFY_ON_TARGET`
- **Primary family:** `11 — Authentication & identity`
- **Description:** Login-auditing tool supporting multiple network services.
- **Primary use cases:** Audit authentication resilience using explicitly authorized test accounts.
- **Typical inputs:** Approved service, test account set, written rate limits.
- **Typical outputs:** Authentication outcomes and service responses.
- **Execution characteristics:** Active authentication attempts
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 49. Medusa

- **Canonical name:** `Medusa`
- **Likely Kali package:** `medusa` — `VERIFY_ON_TARGET`
- **Primary family:** `11 — Authentication & identity`
- **Description:** Parallel network login auditor.
- **Primary use cases:** Controlled authentication testing for approved services.
- **Typical inputs:** Approved service and test credentials.
- **Typical outputs:** Authentication test results.
- **Execution characteristics:** Active authentication attempts
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 50. John the Ripper

- **Canonical name:** `John the Ripper`
- **Likely Kali package:** `john` — `VERIFY_ON_TARGET`
- **Primary family:** `12 — Password auditing`
- **Description:** Password hash auditing and recovery suite.
- **Primary use cases:** Evaluate password-hash strength using authorized hashes.
- **Typical inputs:** Authorized hash files and format metadata.
- **Typical outputs:** Recovered test passwords and audit statistics.
- **Execution characteristics:** Offline
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 51. Hashcat

- **Canonical name:** `Hashcat`
- **Likely Kali package:** `hashcat` — `VERIFY_ON_TARGET`
- **Primary family:** `12 — Password auditing`
- **Description:** GPU/CPU password recovery and hash auditing tool.
- **Primary use cases:** Measure password resistance using approved hash material.
- **Typical inputs:** Authorized hashes and bounded test policy.
- **Typical outputs:** Recovery results and performance metrics.
- **Execution characteristics:** Offline
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 52. CeWL

- **Canonical name:** `CeWL`
- **Likely Kali package:** `cewl` — `VERIFY_ON_TARGET`
- **Primary family:** `12 — Password auditing`
- **Description:** Custom wordlist generator from web content.
- **Primary use cases:** Create assessment-specific candidate dictionaries from approved public content.
- **Typical inputs:** Approved website and crawl limits.
- **Typical outputs:** Wordlist derived from collected terms.
- **Execution characteristics:** Active HTTP requests
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 53. Aircrack-ng

- **Canonical name:** `Aircrack-ng`
- **Likely Kali package:** `aircrack-ng` — `VERIFY_ON_TARGET`
- **Primary family:** `13 — Wireless security`
- **Description:** Wireless network assessment suite.
- **Primary use cases:** Audit owned or explicitly authorized Wi-Fi networks.
- **Typical inputs:** Authorized capture files or test network/interface.
- **Typical outputs:** Wireless metadata and audit results.
- **Execution characteristics:** Active/passive radio
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 54. Kismet

- **Canonical name:** `Kismet`
- **Likely Kali package:** `kismet` — `VERIFY_ON_TARGET`
- **Primary family:** `13 — Wireless security`
- **Description:** Wireless network detector and packet capture system.
- **Primary use cases:** Monitor authorized wireless environments.
- **Typical inputs:** Approved wireless adapter and channels.
- **Typical outputs:** Device observations and packet captures.
- **Execution characteristics:** Passive radio monitoring
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 55. Reaver

- **Canonical name:** `Reaver`
- **Likely Kali package:** `reaver` — `VERIFY_ON_TARGET`
- **Primary family:** `13 — Wireless security`
- **Description:** Wireless WPS security assessment tool.
- **Primary use cases:** Evaluate WPS exposure only on a lab or explicitly authorized AP.
- **Typical inputs:** Authorized test AP and controlled radio interface.
- **Typical outputs:** WPS assessment outcome.
- **Execution characteristics:** Active radio interaction
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 56. Wifite

- **Canonical name:** `Wifite`
- **Likely Kali package:** `wifite` — `VERIFY_ON_TARGET`
- **Primary family:** `13 — Wireless security`
- **Description:** Automation wrapper for wireless security auditing.
- **Primary use cases:** Organize authorized wireless lab assessments.
- **Typical inputs:** Dedicated lab adapter and authorized AP.
- **Typical outputs:** Wireless assessment observations.
- **Execution characteristics:** Active/passive radio
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 57. Bettercap

- **Canonical name:** `Bettercap`
- **Likely Kali package:** `bettercap` — `VERIFY_ON_TARGET`
- **Primary family:** `13 — Wireless security`
- **Description:** Network reconnaissance and testing framework.
- **Primary use cases:** Controlled assessment of owned lab networks and devices.
- **Typical inputs:** Authorized interface and explicit target list.
- **Typical outputs:** Network observations and test results.
- **Execution characteristics:** Active network/radio
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 58. Wireshark

- **Canonical name:** `Wireshark`
- **Likely Kali package:** `wireshark` — `VERIFY_ON_TARGET`
- **Primary family:** `14 — Packet capture & network analysis`
- **Description:** Graphical protocol analyzer for packet captures and live traffic.
- **Primary use cases:** Inspect authorized packet captures and troubleshoot protocols.
- **Typical inputs:** PCAP/PCAPNG files or permitted capture interface.
- **Typical outputs:** Decoded packets, streams, protocol metadata.
- **Execution characteristics:** Passive for files; active capture
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 59. TShark

- **Canonical name:** `TShark`
- **Likely Kali package:** `wireshark-common` — `VERIFY_ON_TARGET`
- **Primary family:** `14 — Packet capture & network analysis`
- **Description:** Command-line packet analyzer.
- **Primary use cases:** Filter and summarize authorized packet captures.
- **Typical inputs:** Capture file or approved interface.
- **Typical outputs:** Packet fields, protocol summaries, extracted metadata.
- **Execution characteristics:** Passive for files; active capture
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 60. tcpdump

- **Canonical name:** `tcpdump`
- **Likely Kali package:** `tcpdump` — `VERIFY_ON_TARGET`
- **Primary family:** `14 — Packet capture & network analysis`
- **Description:** Command-line packet capture utility.
- **Primary use cases:** Capture traffic on interfaces the operator is authorized to monitor.
- **Typical inputs:** Approved interface, capture filter, output file.
- **Typical outputs:** PCAP capture and packet summaries.
- **Execution characteristics:** Passive observation; capture
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 61. ngrep

- **Canonical name:** `ngrep`
- **Likely Kali package:** `ngrep` — `VERIFY_ON_TARGET`
- **Primary family:** `14 — Packet capture & network analysis`
- **Description:** Network packet analyzer with grep-like payload matching.
- **Primary use cases:** Inspect authorized traffic for protocol/content patterns.
- **Typical inputs:** PCAP or permitted interface and filter.
- **Typical outputs:** Matching packet summaries.
- **Execution characteristics:** Passive for files; active capture
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 62. mitmproxy

- **Canonical name:** `mitmproxy`
- **Likely Kali package:** `mitmproxy` — `VERIFY_ON_TARGET`
- **Primary family:** `15 — Traffic interception & proxying`
- **Description:** Interactive TLS-capable HTTP proxy for inspection and modification.
- **Primary use cases:** Inspect application traffic in a controlled test environment.
- **Typical inputs:** Configured test client, local CA trust, approved destination.
- **Typical outputs:** Flow records, requests, responses, scripts.
- **Execution characteristics:** Active interception
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 63. Semgrep

- **Canonical name:** `Semgrep`
- **Likely Kali package:** `semgrep` — `VERIFY_ON_TARGET`
- **Primary family:** `16 — Source code & static analysis`
- **Description:** Rule-based static analysis engine for source code.
- **Primary use cases:** Find insecure coding patterns in authorized repositories.
- **Typical inputs:** Source tree and reviewed rulesets.
- **Typical outputs:** Findings with file/line references.
- **Execution characteristics:** Local
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 64. Bandit

- **Canonical name:** `Bandit`
- **Likely Kali package:** `bandit` — `VERIFY_ON_TARGET`
- **Primary family:** `16 — Source code & static analysis`
- **Description:** Static analyzer for common Python security issues.
- **Primary use cases:** Review Python source for risky constructs.
- **Typical inputs:** Python source tree.
- **Typical outputs:** Finding IDs and source locations.
- **Execution characteristics:** Local
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 65. Gitleaks

- **Canonical name:** `Gitleaks`
- **Likely Kali package:** `gitleaks` — `VERIFY_ON_TARGET`
- **Primary family:** `16 — Source code & static analysis`
- **Description:** Detects secrets and credentials in repositories and files.
- **Primary use cases:** Identify accidentally committed secrets in authorized codebases.
- **Typical inputs:** Repository or directory.
- **Typical outputs:** Secret-like matches with file/line metadata.
- **Execution characteristics:** Local
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 66. Trivy

- **Canonical name:** `Trivy`
- **Likely Kali package:** `trivy` — `VERIFY_ON_TARGET`
- **Primary family:** `16 — Source code & static analysis`
- **Description:** Scanner for vulnerabilities, misconfigurations, secrets, and SBOMs.
- **Primary use cases:** Review source, images, and dependencies for known issues.
- **Typical inputs:** Authorized repository, image, filesystem, or SBOM.
- **Typical outputs:** Vulnerability and configuration findings.
- **Execution characteristics:** Local or registry access
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 67. Checkov

- **Canonical name:** `Checkov`
- **Likely Kali package:** `checkov` — `VERIFY_ON_TARGET`
- **Primary family:** `16 — Source code & static analysis`
- **Description:** Static analysis for infrastructure-as-code configuration.
- **Primary use cases:** Review Terraform, Kubernetes, and cloud configuration.
- **Typical inputs:** Authorized IaC files.
- **Typical outputs:** Policy findings and source locations.
- **Execution characteristics:** Local
- **Operational impact:** **Low–medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 68. Ghidra

- **Canonical name:** `Ghidra`
- **Likely Kali package:** `ghidra` — `VERIFY_ON_TARGET`
- **Primary family:** `17 — Reverse engineering & binary analysis`
- **Description:** Software reverse-engineering framework.
- **Primary use cases:** Inspect authorized binaries, disassemble, and decompile.
- **Typical inputs:** Binary or firmware image the user may analyze.
- **Typical outputs:** Disassembly, decompiled code, cross-references.
- **Execution characteristics:** Local/offline
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 69. Radare2

- **Canonical name:** `Radare2`
- **Likely Kali package:** `radare2` — `VERIFY_ON_TARGET`
- **Primary family:** `17 — Reverse engineering & binary analysis`
- **Description:** Reverse-engineering framework and command-line toolset.
- **Primary use cases:** Inspect executable structure and behavior.
- **Typical inputs:** Authorized binary or memory image.
- **Typical outputs:** Disassembly, strings, symbols, analysis metadata.
- **Execution characteristics:** Local/offline
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 70. Cutter

- **Canonical name:** `Cutter`
- **Likely Kali package:** `cutter` — `VERIFY_ON_TARGET`
- **Primary family:** `17 — Reverse engineering & binary analysis`
- **Description:** GUI reverse-engineering platform built around Rizin.
- **Primary use cases:** Visual binary inspection and analysis.
- **Typical inputs:** Authorized executable or firmware.
- **Typical outputs:** Graph views, disassembly, strings, metadata.
- **Execution characteristics:** Local/offline
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 71. Binwalk

- **Canonical name:** `Binwalk`
- **Likely Kali package:** `binwalk` — `VERIFY_ON_TARGET`
- **Primary family:** `17 — Reverse engineering & binary analysis`
- **Description:** Firmware analysis tool for identifying and extracting embedded data.
- **Primary use cases:** Inspect firmware images for embedded filesystems and components.
- **Typical inputs:** Firmware image obtained lawfully.
- **Typical outputs:** Signature matches and extracted file tree.
- **Execution characteristics:** Local/offline
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 72. MobSF

- **Canonical name:** `MobSF`
- **Likely Kali package:** `mobsf` — `VERIFY_ON_TARGET`
- **Primary family:** `18 — Mobile application security`
- **Description:** Mobile application security testing framework.
- **Primary use cases:** Static/dynamic analysis of authorized mobile application packages.
- **Typical inputs:** APK/IPA and controlled emulator/device.
- **Typical outputs:** Manifest, code, permissions, and security findings.
- **Execution characteristics:** Local; dynamic mode interacts with app
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 73. Apktool

- **Canonical name:** `Apktool`
- **Likely Kali package:** `apktool` — `VERIFY_ON_TARGET`
- **Primary family:** `18 — Mobile application security`
- **Description:** Android APK reverse engineering and resource decoding utility.
- **Primary use cases:** Inspect resources and smali in authorized APKs.
- **Typical inputs:** APK file.
- **Typical outputs:** Decoded resources and smali project.
- **Execution characteristics:** Local/offline
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 74. JADX

- **Canonical name:** `JADX`
- **Likely Kali package:** `jadx` — `VERIFY_ON_TARGET`
- **Primary family:** `18 — Mobile application security`
- **Description:** Dex-to-Java decompiler for Android applications.
- **Primary use cases:** Review decompiled Android application logic.
- **Typical inputs:** Authorized APK/DEX files.
- **Typical outputs:** Java-like source and resource references.
- **Execution characteristics:** Local/offline
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 75. Frida

- **Canonical name:** `Frida`
- **Likely Kali package:** `frida-tools` — `VERIFY_ON_TARGET`
- **Primary family:** `18 — Mobile application security`
- **Description:** Dynamic instrumentation toolkit.
- **Primary use cases:** Observe and test app behavior in a controlled device/lab.
- **Typical inputs:** Authorized app process and test device.
- **Typical outputs:** Runtime hooks, traces, and observations.
- **Execution characteristics:** Local instrumentation
- **Operational impact:** **Medium–high**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 76. sqlite3

- **Canonical name:** `sqlite3`
- **Likely Kali package:** `sqlite3` — `VERIFY_ON_TARGET`
- **Primary family:** `19 — Database & data-service assessment`
- **Description:** SQLite command-line database client.
- **Primary use cases:** Inspect local SQLite databases and application data stores.
- **Typical inputs:** Authorized database file.
- **Typical outputs:** Schema, rows, and query results.
- **Execution characteristics:** Local
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 77. sqlmap

- **Canonical name:** `sqlmap`
- **Likely Kali package:** `sqlmap` — `VERIFY_ON_TARGET`
- **Primary family:** `19 — Database & data-service assessment`
- **Description:** Automates detection and validation of SQL injection conditions.
- **Primary use cases:** Validate suspected SQL injection only on explicitly authorized test targets.
- **Typical inputs:** Approved URL/request and strict non-destructive policy.
- **Typical outputs:** Detection evidence and database behavior observations.
- **Execution characteristics:** Active HTTP/database requests
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 78. Redis-cli

- **Canonical name:** `Redis-cli`
- **Likely Kali package:** `redis-tools` — `VERIFY_ON_TARGET`
- **Primary family:** `19 — Database & data-service assessment`
- **Description:** Command-line Redis client.
- **Primary use cases:** Review Redis service configuration and authorized access.
- **Typical inputs:** Approved Redis endpoint and credentials.
- **Typical outputs:** Server info, keys/data allowed by policy, command responses.
- **Execution characteristics:** Active service connection
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 79. Mongosh

- **Canonical name:** `Mongosh`
- **Likely Kali package:** `mongodb-mongosh` — `VERIFY_ON_TARGET`
- **Primary family:** `19 — Database & data-service assessment`
- **Description:** MongoDB interactive shell.
- **Primary use cases:** Review MongoDB configuration and access controls.
- **Typical inputs:** Authorized MongoDB URI and least-privileged credentials.
- **Typical outputs:** Database metadata and permitted query results.
- **Execution characteristics:** Active service connection
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 80. Autopsy

- **Canonical name:** `Autopsy`
- **Likely Kali package:** `autopsy` — `VERIFY_ON_TARGET`
- **Primary family:** `20 — Forensics & incident response`
- **Description:** Digital forensics platform built around The Sleuth Kit.
- **Primary use cases:** Examine disk images and preserve case-based findings.
- **Typical inputs:** Forensic image and case metadata.
- **Typical outputs:** File system artifacts, timelines, reports.
- **Execution characteristics:** Offline analysis
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 81. The Sleuth Kit

- **Canonical name:** `The Sleuth Kit`
- **Likely Kali package:** `sleuthkit` — `VERIFY_ON_TARGET`
- **Primary family:** `20 — Forensics & incident response`
- **Description:** Command-line tools for filesystem forensic analysis.
- **Primary use cases:** Inspect disk images and filesystem metadata.
- **Typical inputs:** Read-only forensic image.
- **Typical outputs:** Filesystem metadata and artifact listings.
- **Execution characteristics:** Offline analysis
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 82. Volatility 3

- **Canonical name:** `Volatility 3`
- **Likely Kali package:** `volatility3` — `VERIFY_ON_TARGET`
- **Primary family:** `20 — Forensics & incident response`
- **Description:** Memory forensics framework.
- **Primary use cases:** Analyze authorized memory captures for processes and artifacts.
- **Typical inputs:** Memory image and matching symbols.
- **Typical outputs:** Process, module, and memory artifacts.
- **Execution characteristics:** Offline analysis
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 83. Foremost

- **Canonical name:** `Foremost`
- **Likely Kali package:** `foremost` — `VERIFY_ON_TARGET`
- **Primary family:** `20 — Forensics & incident response`
- **Description:** File carving utility.
- **Primary use cases:** Recover file fragments from forensic images.
- **Typical inputs:** Forensic image or authorized raw data.
- **Typical outputs:** Carved files and offsets.
- **Execution characteristics:** Offline analysis
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 84. ExifTool

- **Canonical name:** `ExifTool`
- **Likely Kali package:** `libimage-exiftool-perl` — `VERIFY_ON_TARGET`
- **Primary family:** `20 — Forensics & incident response`
- **Description:** Reads and writes metadata across many file formats.
- **Primary use cases:** Inspect metadata during evidence triage.
- **Typical inputs:** Evidence copies of images/documents/media.
- **Typical outputs:** Metadata fields and extraction logs.
- **Execution characteristics:** Offline/local
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 85. jq

- **Canonical name:** `jq`
- **Likely Kali package:** `jq` — `VERIFY_ON_TARGET`
- **Primary family:** `21 — Reporting & evidence utilities`
- **Description:** Command-line JSON processor.
- **Primary use cases:** Normalize and filter structured tool output.
- **Typical inputs:** JSON documents or streams.
- **Typical outputs:** Transformed JSON and selected fields.
- **Execution characteristics:** Local
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 86. yq

- **Canonical name:** `yq`
- **Likely Kali package:** `yq` — `VERIFY_ON_TARGET`
- **Primary family:** `21 — Reporting & evidence utilities`
- **Description:** Command-line YAML/XML/JSON processor.
- **Primary use cases:** Normalize configuration and structured evidence.
- **Typical inputs:** YAML, JSON, or XML files.
- **Typical outputs:** Filtered/transformed structured data.
- **Execution characteristics:** Local
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 87. Faraday

- **Canonical name:** `Faraday`
- **Likely Kali package:** `faraday` — `VERIFY_ON_TARGET`
- **Primary family:** `21 — Reporting & evidence utilities`
- **Description:** Collaborative vulnerability-management and reporting platform.
- **Primary use cases:** Organize findings and evidence across an authorized assessment.
- **Typical inputs:** Tool outputs and analyst-validated findings.
- **Typical outputs:** Deduplicated issues, workspaces, reports.
- **Execution characteristics:** Local/service
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 88. Dradis

- **Canonical name:** `Dradis`
- **Likely Kali package:** `dradis` — `VERIFY_ON_TARGET`
- **Primary family:** `21 — Reporting & evidence utilities`
- **Description:** Security assessment collaboration and reporting platform.
- **Primary use cases:** Collect evidence and prepare structured client reports.
- **Typical inputs:** Validated findings, notes, and attachments.
- **Typical outputs:** Assessment records and report exports.
- **Execution characteristics:** Local/service
- **Operational impact:** **Low**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 89. Pacu

- **Canonical name:** `Pacu`
- **Likely Kali package:** `pacu` — `VERIFY_ON_TARGET`
- **Primary family:** `21 — Reporting & evidence utilities`
- **Description:** AWS exploitation and assessment framework.
- **Primary use cases:** Assess AWS security posture only in an explicitly authorized account/lab.
- **Typical inputs:** Authorized AWS account, scoped role, and test plan.
- **Typical outputs:** Cloud configuration and assessment observations.
- **Execution characteristics:** Active cloud API calls
- **Operational impact:** **High**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

### 90. ScoutSuite

- **Canonical name:** `ScoutSuite`
- **Likely Kali package:** `scoutsuite` — `VERIFY_ON_TARGET`
- **Primary family:** `21 — Reporting & evidence utilities`
- **Description:** Multi-cloud security auditing tool.
- **Primary use cases:** Review cloud account configuration with approved read-only access.
- **Typical inputs:** Authorized cloud credentials and account scope.
- **Typical outputs:** Configuration findings and audit report.
- **Execution characteristics:** Cloud API read operations
- **Operational impact:** **Medium**
- **Availability:** `UNKNOWN` — must be established by live environment discovery.
- **Version / executable path:** `NEEDS_VERIFICATION`.
- **Authorization:** Use only against assets, accounts, devices, captures, or code explicitly owned by the operator or covered by written authorization. Apply engagement exclusions and rate limits.
- **Evidence:** Preserve original output, UTC timestamp, tool version, exact approved target identifier, relevant configuration, and a cryptographic hash where appropriate.

---

## Research methodology

The database uses the eight-stage methodology established for the project:

1. **Observe** — collect permitted facts and preserve source provenance.
2. **Model** — understand the system, trust boundaries, identities, data flows, and expected behavior.
3. **Hypothesize** — state a falsifiable security hypothesis and its assumptions.
4. **Test** — choose the lowest-impact authorized test that can distinguish the hypothesis.
5. **Validate** — reproduce and independently verify the observed behavior; rule out scanner noise and environmental artifacts.
6. **Assess Impact** — determine realistic security consequences without escalating beyond what is necessary to prove them.
7. **Report** — provide concise reproduction context, evidence, affected scope, impact, and remediation.
8. **Learn** — record reusable lessons, false positives, environmental constraints, and improvements to future testing.

### Separate facts, inferences, and hypotheses

- **Fact:** directly supported by captured evidence or authoritative source material.
- **Inference:** a reasoned interpretation of facts; state the reasoning and uncertainty.
- **Hypothesis:** an unverified explanation or suspected weakness that still requires testing.
- **Validated finding:** a claim reproduced within scope and supported by sufficient evidence.
- **Unconfirmed lead:** a scanner result or observation that has not met the validation standard.

Do not promote a hypothesis to a finding merely because a tool reports a match.

## Authorization and impact model

### Required preflight

Before any active operation, the orchestrator must establish:

1. The engagement/program identity and authoritative policy source.
2. Exact in-scope domains, IP ranges, applications, accounts, and test environments.
3. Explicit exclusions, prohibited techniques, rate limits, testing windows, and data-handling requirements.
4. Whether automation, scanners, authenticated testing, and third-party services are permitted.
5. The selected tool's verified identity, version, configuration, and expected network/state impact.
6. The required human approval and the approved execution boundary.

### Prohibited assumptions

- A public hostname is not automatically in scope.
- A discovered subdomain, IP, API, cloud asset, or third-party service is not automatically authorized.
- A tool's presence in Kali does not authorize its use.
- A successful connection does not prove permission.
- A bug bounty program's general invitation does not override explicit exclusions or technique restrictions.
- Credentials, tokens, personal data, and customer data must not be extracted or retained beyond what policy permits.

### Safer validation hierarchy

Prefer, in order where suitable:

1. Static inspection of supplied code/configuration.
2. Offline analysis of supplied captures, files, or binaries.
3. Passive public-source research permitted by the program.
4. Read-only service and configuration checks.
5. Minimal active verification using a test account and harmless data.
6. State-changing or high-volume testing only when explicitly permitted and specifically approved.

Stop immediately if a test risks service disruption, data modification, access to another user's data, credential exposure, or crossing a scope boundary.

## Evidence quality and reporting

### Evidence record

Every material observation should record:

| Field | Requirement |
|---|---|
| `evidence_id` | Stable unique identifier. |
| `engagement_id` | Approved engagement or lab identifier. |
| `observed_at` | UTC timestamp in ISO 8601. |
| `source` | Tool, browser, manual observation, file, or authoritative reference. |
| `tool_identity` | Verified canonical name, package, version, and executable path where applicable. |
| `target` | Exact in-scope asset identifier; redact sensitive values in shared reports. |
| `authorization_ref` | Scope/policy record authorizing the activity. |
| `method` | High-level method and relevant non-sensitive settings. |
| `raw_artifact` | Original output/capture path or immutable artifact reference. |
| `sha256` | Hash of retained artifact where appropriate. |
| `interpretation` | What the evidence supports, and what it does not prove. |
| `validation_status` | `LEAD`, `REPRODUCED`, `VALIDATED`, `FALSE_POSITIVE`, or `INCONCLUSIVE`. |

### Finding quality gates

- The affected asset is confirmed in scope.
- The behavior is reproducible or supported by strong independent evidence.
- The root cause is distinguished from symptoms.
- Impact is realistic and tied to a security property.
- The report avoids unnecessary sensitive data and destructive proof.
- Remediation is actionable and proportionate.

## Environment availability and package verification

This catalogue is not a substitute for live discovery. The runtime registry should independently verify:

- package manager record and installed package version;
- executable resolution and canonical path;
- executable/package ownership and file identity;
- tool version output where safe and supported;
- required dependencies and runtime compatibility;
- whether the current substrate is host, VM, container, or remote environment;
- whether the tool is available, missing, broken, or identity-unverified.

### Recommended availability states

| State | Meaning |
|---|---|
| `AVAILABLE_VERIFIED` | Package and executable identity/version verified on the active substrate. |
| `AVAILABLE_UNVERIFIED` | A command appears resolvable, but identity/version is not fully verified. |
| `MISSING` | Not installed or not resolvable. |
| `BROKEN` | Present but unusable due to missing dependencies or failed health check. |
| `UNSUPPORTED` | Incompatible with the active substrate or architecture. |
| `UNKNOWN` | No reliable environment snapshot supplied. |

An unverified identity must never be promoted to available-for-execution. Discovery records availability only; it grants no authorization.

## Catalogue verification and expansion

### Authoritative sources

- Kali package tracker: https://pkg.kali.org/
- Kali documentation: https://www.kali.org/docs/
- Kali metapackages: https://www.kali.org/tools/kali-meta/
- Debian package metadata (where Kali inherits package metadata): https://packages.debian.org/
- Upstream project documentation for tool-specific behavior and supported versions.

### Verification procedure

1. Capture the Kali release/snapshot identifier and repository metadata timestamp.
2. Retrieve the official package index and current metapackage dependency data.
3. Normalize package names separately from executable names, upstream project names, and aliases.
4. Resolve each candidate tool to a package record and record source URL, version, architecture, and repository component.
5. Verify whether the package is present in the selected Kali release; do not infer from an upstream project page.
6. Verify executable paths and versions on the actual target environment before marking a tool available.
7. Record tools that are renamed, removed, transitional, duplicated, or provided by a different package.
8. Generate the full inventory and manifest from the captured source data; fail closed on count mismatch or duplicate canonical IDs.

### Metapackage handling

The earlier project plan referred to **36 Kali metapackages**. Their names and dependency lists must be captured from the same dated Kali repository snapshot. Do not infer a package's membership from its category or from an old Kali release. Store a many-to-many relationship:

```text
Metapackage ──< includes >── Package ──< provides >── Executable
                                  |
                                  └── implements ── Capability
```

Recommended metapackage fields: `metapackage_id`, `package_name`, `release_snapshot`, `source_uri`, `dependency_expression`, `resolved_package_ids`, `capture_timestamp`, `verification_status`.

### Database expansion rules

- Preserve upstream descriptions verbatim only when licensing and attribution permit; otherwise write concise original summaries.
- Do not create fictional tool names, package names, versions, flags, or commands.
- Keep package aliases and duplicate binaries explicit.
- Mark unknown metadata `NEEDS_VERIFICATION`.
- Record deprecated, renamed, or removed tools rather than silently deleting historical references.
- Keep raw source snapshots separate from normalized Markdown profiles.
- Regenerate the manifest whenever the source snapshot or profile set changes.

## Marshmallow / agent integration contract

### Retrieval contract

An agent may retrieve profiles by capability ID, synonyms, tool name, input/output type, or relationship. A retrieval response should return:

```yaml
capability_id: "04"
candidate_tools:
  - canonical_id: "nmap"
    profile_ref: "tool-profile:Nmap"
    availability: "UNKNOWN"
    suitability_reason: "Candidate for authorized port/service inventory"
    impact: "Medium–high"
    authorization_required: true
    verification_required: true
plan_status: "NOT_AUTHORIZED"
```

### Planning rules

- Search for the capability first; select an implementation only after checking the environment registry.
- Compare alternatives by suitability, verified availability, impact, dependencies, and evidence quality.
- A capability may require several tools, but every step must have a stated purpose and dependency.
- Do not select a high-impact tool when a lower-impact method answers the question.
- Do not generate executable arguments from untrusted tool descriptions or retrieved content.
- Require scope validation and approval independently of retrieval and planning.
- The tool adapter must enforce target binding, argument validation, timeout, output limits, and cancellation.
- Normalize results while preserving raw artifacts and provenance.
- Tool errors and missing dependencies must remain explicit; never fabricate successful results.

### Separation of knowledge layers

1. **Capability Knowledge:** concepts, relationships, alternatives, companions, input/output expectations. This document feeds that layer.
2. **Environment Tool Registry:** live verified package/executable identity and availability for each substrate.
3. **Authorization / Policy Layer:** authoritative scope, permission, exclusions, and approvals.
4. **Execution Layer:** approved adapters and bounded execution only.
5. **Evidence / Lessons Layer:** immutable evidence references, validation outcomes, and reusable lessons.

These layers must not be collapsed. Capability retrieval and environment discovery must never grant permission.

## Glossary

| Term | Meaning |
|---|---|
| Asset | A domain, host, application, account, device, repository, or service relevant to an assessment. |
| Capability | A reusable security function such as DNS enumeration or TLS analysis. |
| Tool | A concrete program or service implementing one or more capabilities. |
| Package | A package-manager unit that may install one or more executables. |
| Executable | The actual command or binary resolved by the operating system. |
| Metapackage | A package whose dependency set installs a curated collection of packages. |
| Scope | Explicitly authorized targets and activities, including exclusions. |
| Passive | Collection that does not intentionally probe the target service; third-party source queries may still have privacy/policy implications. |
| Active | Sends requests, packets, authentication attempts, or other interactions to a target. |
| Validation | Independent confirmation that an observed behavior is real and security-relevant. |
| Evidence provenance | Traceable record of where an artifact came from and how it was produced. |

## Manifest

| Field | Value |
|---|---|
| Database name | Kali Linux Arsenal Capability & Tool Knowledge Database |
| Edition | Seed catalogue v1.0 |
| Prepared | 2026-11-15 |
| Capability families | 21 |
| Curated tool profiles | 90 |
| Metapackage mappings | Not populated; requires dated authoritative capture |
| Live package verification | Not performed in this generated edition |
| Package names | Likely mappings; all require target-release verification |
| Intended source of truth | Kali package repositories, Kali documentation, and upstream project documentation |
| Execution authority | None — this is a knowledge/index document only |

### Profile count by capability family

| Family ID | Family | Profiles |
|---|---|---:|
| `01` | Asset discovery & OSINT | 7 |
| `02` | DNS & domain intelligence | 5 |
| `03` | Network discovery & mapping | 6 |
| `04` | Port & service identification | 5 |
| `05` | Web application assessment | 6 |
| `06` | API assessment | 2 |
| `07` | Content & directory discovery | 4 |
| `08` | TLS & cryptographic configuration | 3 |
| `09` | Vulnerability identification | 5 |
| `10` | Fuzzing & input robustness | 4 |
| `11` | Authentication & identity | 2 |
| `12` | Password auditing | 3 |
| `13` | Wireless security | 5 |
| `14` | Packet capture & network analysis | 4 |
| `15` | Traffic interception & proxying | 1 |
| `16` | Source code & static analysis | 5 |
| `17` | Reverse engineering & binary analysis | 4 |
| `18` | Mobile application security | 4 |
| `19` | Database & data-service assessment | 4 |
| `20` | Forensics & incident response | 5 |
| `21` | Reporting & evidence utilities | 6 |
| **Total** | **All families** | **90** |

### Integrity checks

- [x] Exactly 21 capability families defined.
- [x] Exactly 90 unique curated seed profiles included.
- [x] Every profile has a family, description, use case, input/output expectations, execution characteristics, impact, availability state, and authorization note.
- [x] Unknown live package/version/availability data is explicitly marked for verification.
- [ ] Capture and verify the live Kali package catalogue for a named release.
- [ ] Resolve the 36 referenced metapackages and their package dependencies from that same release snapshot.
- [ ] Validate package-to-executable mappings on the target Kali environment.

**End of database.**
