
# ETHICAL HACKING MASTER KNOWLEDGE BASE — BUG BOUNTY EDITION
## Expanded internal reference for Claude Code

### Primary mission

This project will use Claude Code **heavily for authorized bug-bounty work**. Bug bounty research is not a side feature; it is one of the primary intended uses of this knowledge base.

Claude should therefore optimize its cybersecurity reasoning around:

- discovering attack surfaces efficiently;
- understanding applications before attacking them;
- identifying authorization and business-logic failures;
- validating vulnerabilities with minimal impact;
- chaining individually minor weaknesses when the program rules permit it;
- determining realistic security impact;
- writing high-quality vulnerability reports;
- learning from accepted/rejected reports;
- remembering lessons from previous authorized engagements;
- improving its methodology over time.

The knowledge base is intended to supplement Claude's general model knowledge with a structured, persistent reference. It is **not expected to contain literally every fact in cybersecurity**. Instead, it should contain the most useful conceptual knowledge, testing methodology, bug-bounty reasoning patterns, terminology, decision frameworks, and practical heuristics, while Claude researches current details when necessary.

---

# PART I — HOW TO THINK LIKE A BUG BOUNTY RESEARCHER

## 1. The fundamental loop

A strong researcher repeatedly performs:

`Observe → Model → Hypothesize → Test → Validate → Assess Impact → Report → Learn`

Do not begin with:

> "Which payload should I try?"

Begin with:

> "What security property should be true here, and what assumption might make it false?"

Examples:

- A user should only access their own object.
- A normal user should not execute administrator-only actions.
- A password-reset token should only work for the intended account.
- A tenant should not access another tenant's data.
- A server should not make arbitrary requests to internal resources on behalf of a user.
- A payment workflow should not allow impossible state transitions.
- A signed request should not be reusable outside its intended context.

This mindset is more valuable than memorizing thousands of payloads.

---

# 2. Application modeling

Before testing an application, build an informal model.

Record:

### Actors
- anonymous user
- normal user
- privileged user
- administrator
- support staff
- API client
- service account
- third-party integration

### Assets
- accounts
- profiles
- files
- messages
- invoices
- payments
- API keys
- sessions
- organizations
- projects
- administrative functions

### Trust boundaries
Identify where data crosses from:

- browser → server
- user → API
- tenant → tenant
- application → third-party service
- public → internal
- low privilege → high privilege
- frontend → backend
- application → cloud service

### State transitions

Ask:

- What states can an object have?
- Who is allowed to change each state?
- Can states be skipped?
- Can requests be replayed?
- Can two requests happen simultaneously?
- Does the server trust client-supplied state?

---

# 3. The authorization matrix

For serious bug bounty work, build a matrix:

| Actor | Object | Read | Create | Update | Delete | Special Action |
|---|---|---:|---:|---:|---:|---:|
| Anonymous | Public object | ✓ | - | - | - | - |
| User A | User A object | ✓ | ✓ | ✓ | ✓ | ✓ |
| User A | User B object | ? | ? | ? | ? | ? |
| Admin | User B object | ✓ | ✓ | ✓ | ✓ | ✓ |

The question marks are where interesting security hypotheses often live.

Never assume that hiding an action in the UI means it is protected. Test the server-side authorization boundary.

---

# 4. Horizontal vs vertical authorization

### Horizontal privilege escalation

One user accesses another user's resources at the same privilege level.

Typical conceptual pattern:

`User A → Object belonging to User B`

### Vertical privilege escalation

A lower-privileged user performs a higher-privileged action.

Typical conceptual pattern:

`Normal User → Administrator-only operation`

### Context-dependent authorization

Also consider:

- organization membership
- project membership
- team membership
- ownership
- temporary roles
- suspended accounts
- deleted accounts
- invited users
- support roles
- service identities

---

# 5. Identifier reasoning

Whenever an application exposes an identifier, ask what security property protects it.

Identifiers may include:

- numeric IDs
- UUIDs
- usernames
- emails
- filenames
- slugs
- database keys
- opaque tokens
- GraphQL IDs
- resource URLs

An unpredictable identifier is **not** a substitute for authorization.

The important property is:

> Does the server verify that the requesting principal is authorized to access the identified object?

---

# 6. Request comparison

When investigating a workflow, compare requests rather than looking at one request in isolation.

Look for differences in:

- HTTP method
- path
- parameters
- headers
- cookies
- authorization tokens
- content type
- JSON fields
- object identifiers
- role-related fields
- organization identifiers
- client-side-only fields
- server-generated fields

The goal is to identify which fields actually control security decisions.

---

# PART II — WEB APPLICATION SECURITY KNOWLEDGE

# 7. HTTP mental model

Understand:

`Request = Method + Target + Headers + Body`

`Response = Status + Headers + Body`

Important methods:

- GET
- POST
- PUT
- PATCH
- DELETE
- OPTIONS
- HEAD

Understand:

- URL parsing
- query strings
- path parameters
- form encoding
- JSON
- multipart forms
- cookies
- authorization headers
- redirects
- caching
- content negotiation

Security often depends on how different components parse the same request.

---

# 8. HTTP parsing differences

A recurring vulnerability theme is:

> Component A interprets a request differently from Component B.

Relevant areas:

- proxies
- reverse proxies
- WAFs
- load balancers
- application servers
- caches
- backend frameworks

This principle appears in request smuggling, cache poisoning, URL parsing problems, header confusion, and other parser-differential vulnerabilities.

When studying these vulnerabilities, focus on the disagreement between components rather than memorizing a single payload.

---

# 9. SQL injection

### Root cause

Untrusted input changes the intended structure of a database query.

### Security property

User-controlled data should remain data rather than becoming executable query syntax.

### Main prevention

- parameterized queries
- prepared statements
- safe query builders
- least-privileged database accounts
- input validation as defense-in-depth

### Research reasoning

Determine:

1. Is input reaching a database operation?
2. Is the value interpreted as data or syntax?
3. What database technology is involved?
4. Is the behavior deterministic?
5. What is the minimum safe proof?

Do not assume every database error is SQL injection.

---

# 10. NoSQL injection

NoSQL systems may have different query languages and data models.

Potential root causes include:

- unsafe object construction
- user-controlled query operators
- weak type validation
- server-side query manipulation

Study the application's actual database abstraction instead of assuming SQL-style behavior.

---

# 11. Cross-site scripting

XSS occurs when attacker-controlled data reaches a browser execution context without appropriate contextual protection.

Important categories:

- reflected
- stored
- DOM-based

Think in terms of:

`Source → Data Flow → Sink → Browser Context`

Different contexts require different defenses:

- HTML
- attribute
- JavaScript
- CSS
- URL
- DOM APIs

Primary defenses include:

- contextual output encoding
- safe DOM APIs
- input constraints
- CSP
- Trusted Types where appropriate

---

# 12. Cross-site request forgery

CSRF abuses a browser's authenticated state to cause an unwanted action.

Understand:

- cookie authentication
- SameSite
- CSRF tokens
- origin validation
- referer/origin checks
- state-changing HTTP methods

Important question:

> Can an attacker cause a victim's browser to perform a state-changing action while the application accepts the victim's authentication context?

---

# 13. SSRF

Server-side request forgery occurs when an application makes network requests based on attacker-controlled input without enforcing the intended destination policy.

Think in terms of:

`User Input → URL Parser → Network Request → Destination`

Security questions:

- Which schemes are allowed?
- Which hosts are allowed?
- How are redirects handled?
- Is DNS re-resolution involved?
- Are private destinations reachable?
- Are cloud metadata services protected?
- Does the application validate the final destination?

Defenses:

- strict allowlists
- safe URL parsing
- network segmentation
- egress controls
- redirect restrictions
- metadata-service protections

---

# 14. Path traversal

Root cause:

User-controlled path data escapes the intended filesystem boundary.

Security model:

`Requested Path ⊆ Intended Directory`

Study:

- canonicalization
- normalization
- symbolic links
- encoding
- archive extraction
- platform-specific path rules

Defense:

- avoid constructing paths from raw user input
- canonicalize safely
- enforce directory boundaries after canonicalization
- use dedicated filesystem APIs

---

# 15. File upload vulnerabilities

Do not reduce upload security to file extensions.

Consider:

- content type
- file signatures
- parser behavior
- storage location
- filename handling
- execution permissions
- image/document processing
- archive extraction
- decompression
- antivirus scanning
- access control
- object-storage permissions

A secure upload design separates uploaded data from executable application resources.

---

# 16. XXE and parser security

XML parsers can become dangerous when external entities or other features allow unintended resource access.

Study:

- parser configuration
- external entities
- DTD processing
- network access
- local file access
- entity expansion
- parser differences

Prefer disabling unnecessary XML features and using hardened parsers.

---

# 17. Deserialization

Unsafe deserialization occurs when an application reconstructs complex objects from untrusted serialized data in a way that permits unintended behavior.

Understand:

- object graphs
- type metadata
- gadget chains
- integrity protection
- safe serialization formats
- allowlists

Primary defense:

> Do not deserialize untrusted data into powerful runtime object types unless the format and types are strictly controlled.

---

# 18. Authentication security

Authentication answers:

> Who are you?

Study:

- password authentication
- MFA
- passkeys
- WebAuthn
- session creation
- password reset
- account recovery
- email verification
- device verification
- SSO
- OAuth
- OIDC
- SAML

Look for inconsistencies between:

- login
- registration
- password reset
- email change
- MFA enrollment
- MFA recovery
- session revocation
- account linking

Authentication systems often fail at secondary flows rather than the main login page.

---

# 19. Session security

A session represents authenticated state.

Study:

- session identifiers
- cookies
- expiration
- rotation
- revocation
- fixation
- logout
- concurrent sessions
- device sessions
- refresh tokens

A secure logout should invalidate relevant server-side authentication state where the architecture requires it.

---

# 20. OAuth security

Understand OAuth as an authorization framework, not simply “login.”

Concepts:

- resource owner
- client
- authorization server
- resource server
- redirect URI
- authorization code
- access token
- refresh token
- scopes
- PKCE
- state

Common design problems:

- weak redirect URI validation
- missing state protection
- token leakage
- scope confusion
- account-linking flaws
- client confusion
- insecure token storage

---

# 21. JWT security

A JWT is a structured token, not automatically a secure authentication mechanism.

Understand:

- header
- claims
- signature
- issuer
- audience
- expiration
- key identifiers
- signing algorithms

Security depends on:

- proper signature verification
- trusted issuer
- trusted audience
- key management
- algorithm handling
- claim validation
- token lifetime

Never treat changing a token's encoded fields as equivalent to successfully bypassing verification.

---

# 22. Business logic vulnerabilities

Business logic is where application-specific assumptions become security boundaries.

Examples:

- buying something for an impossible price
- using a coupon multiple times
- performing an action without required prerequisites
- changing an object after authorization but before execution
- reusing a one-time invitation
- manipulating workflow order
- bypassing limits through multiple paths

Method:

1. Understand intended workflow.
2. Identify state transitions.
3. Identify security assumptions.
4. Ask whether the server independently enforces them.
5. Test unusual but logically plausible sequences.

---

# 23. Race conditions

A race occurs when security depends on timing or ordering.

Conceptual pattern:

`Check → Time gap → Use`

If multiple requests can reach the system between those stages, the security assumption may fail.

Study:

- atomic operations
- locks
- transactions
- idempotency
- unique constraints
- optimistic concurrency
- distributed systems

---

# PART III — BUG BOUNTY OPERATING SYSTEM

# 24. Program intake

For every program create a structured record:

```text
Program:
Platform:
Policy URL:
Scope:
Out of scope:
Rate limits:
Prohibited actions:
Authentication requirements:
Safe-harbor:
Disclosure policy:
Known testing restrictions:
Reward/severity information:
Last policy verification:
```

Never assume a program's rules from another program.

---

# 25. Asset inventory

Create:

```text
Asset
├── hostname
├── application
├── API
├── authentication
├── technology
├── roles
├── functionality
├── third-party integrations
└── notes
```

Prioritize assets based on:

- sensitivity
- complexity
- authentication surface
- custom functionality
- business importance
- novelty
- historical vulnerability density

---

# 26. Reconnaissance strategy

Recon should answer questions.

Bad recon:

> Collect everything.

Better recon:

> Identify assets that expose unusual trust boundaries or custom functionality.

Useful information categories:

- domains
- subdomains
- DNS
- certificates
- application endpoints
- APIs
- public documentation
- JavaScript
- technology fingerprints
- public repositories
- mobile applications
- cloud exposure
- historical assets

Do not turn reconnaissance into uncontrolled mass scanning.

---

# 27. JavaScript analysis

Modern applications often expose useful architecture information in client code.

Look for:

- API routes
- endpoint names
- feature flags
- role names
- object models
- GraphQL schemas
- configuration
- third-party services
- environment assumptions
- client-side authorization logic

Client-side authorization is not a security boundary, but its presence can reveal the intended server-side API structure.

---

# 28. API discovery

For every application identify:

- REST endpoints
- GraphQL
- WebSockets
- mobile APIs
- internal-looking endpoints
- versioned APIs
- deprecated APIs

Compare:

- documented API
- frontend API
- mobile API
- legacy API

A common security issue is inconsistent security controls between different interfaces to the same backend functionality.

---

# 29. Endpoint classification

Classify endpoints:

### Read
Returns information.

### Write
Creates or modifies information.

### Privileged
Requires elevated authorization.

### Sensitive
Handles credentials, payment, identity, private data, or security settings.

### State transition
Changes workflow state.

### Administrative
Changes system configuration or users.

Prioritize sensitive and state-changing endpoints for manual reasoning.

---

# 30. Finding chains

Do not assume a vulnerability must be catastrophic by itself.

A chain may look conceptually like:

`Information Disclosure → Account Identifier → Authorization Weakness → Sensitive Action`

or:

`Low-Privilege Feature → Missing Authorization → Privileged Object → Security Impact`

When chaining:

- verify each step
- minimize impact
- explain causal relationships
- determine whether the final impact is realistic
- avoid speculative chains

---

# 31. Severity reasoning

Do not inflate severity.

Assess:

### Preconditions
What must the attacker already have?

### Exploit complexity
How difficult is exploitation?

### User interaction
Is another person required?

### Privileges
Does the attacker need an account or elevated role?

### Scope
Does the flaw cross a trust boundary?

### Confidentiality
What information can be exposed?

### Integrity
What can be changed?

### Availability
Can service be disrupted?

### Business impact
What does this mean for the actual organization?

Severity should follow evidence.

---

# 32. Report quality

A strong report is:

- reproducible
- concise
- technically precise
- evidence-based
- impact-focused
- respectful of scope
- easy for engineering teams to fix

Use:

```text
Title

Summary

Affected asset

Prerequisites

Steps to reproduce

Expected behavior

Actual behavior

Security impact

Evidence

Root cause

Recommended remediation

Regression test

Notes / limitations
```

Do not bury the actual vulnerability under a giant wall of tool output.

---

# 33. Learning from triage

When a report is accepted:

Record:

- what made it valid
- what evidence proved impact
- what test assumption was correct
- what was initially uncertain
- what remediation was recommended
- what related bug classes should be checked

When a report is rejected:

Record the reason:

- not reproducible
- intended behavior
- out of scope
- insufficient impact
- duplicate
- informational
- rate-limit issue
- policy violation
- missing evidence

Do not simply conclude “the bug was useless.”

Turn every result into a reusable lesson.

---

# PART IV — RECON, SPOOFING, IDENTITY & NETWORK SECURITY

# 34. DNS security

Understand:

- A/AAAA
- CNAME
- MX
- TXT
- NS
- DNSSEC
- wildcard records
- delegation
- caching
- recursive resolution

Security concepts:

- DNS misconfiguration
- dangling records
- subdomain takeover concepts
- DNS poisoning
- cache poisoning
- trust in DNS responses

---

# 35. ARP

ARP maps IP addresses to link-layer addresses on local networks.

Security weakness:

ARP does not inherently authenticate responses.

Study:

- ARP cache
- gratuitous ARP
- network segmentation
- dynamic ARP inspection
- monitoring

Practice spoofing only in isolated networks you control.

---

# 36. IP spoofing

IP source addresses can be forged in some network contexts because the source address is not itself cryptographic proof of identity.

Defenses include:

- ingress/egress filtering
- routing controls
- authenticated protocols
- network monitoring

Do not confuse spoofing a source address with receiving replies through a normal TCP connection; protocol behavior and network topology matter.

---

# 37. Email spoofing

Email security involves:

- SPF
- DKIM
- DMARC
- alignment
- domain authentication
- mail gateways

Understand:

- envelope sender
- visible From header
- authenticated domain
- DMARC policy

Defensive goal:

> Make it difficult for unauthorized senders to impersonate trusted domains.

---

# PART V — OPERATING SYSTEM & INFRASTRUCTURE SECURITY

# 38. Privilege escalation reasoning

Privilege escalation usually results from crossing a security boundary.

Look for:

- excessive permissions
- dangerous services
- weak file permissions
- exposed credentials
- insecure scheduled tasks
- unsafe environment variables
- vulnerable software
- misconfigured identity controls

Do not treat a local weakness as exploitable until you establish:

`Attacker Capability → Weakness → Privilege Boundary → Result`

---

# 39. Windows security model

Understand:

- users
- groups
- SIDs
- access tokens
- ACLs
- privileges
- services
- scheduled tasks
- registry
- processes
- integrity levels
- UAC

Security is based heavily on identity and access-control decisions.

---

# 40. Linux security model

Understand:

- UID/GID
- file permissions
- capabilities
- processes
- namespaces
- services
- discretionary access controls
- mandatory access controls

A permission such as `rwx` is only one layer of the Linux security model.

---

# 41. Cloud identity

Cloud security is often identity security.

Study:

- users
- roles
- policies
- service identities
- workload identities
- temporary credentials
- trust policies
- resource policies

Core principle:

> Give each workload only the permissions it needs, for only as long as it needs them.

---

# PART VI — ADVANCED SECURITY RESEARCH

# 42. Fuzzing methodology

A useful fuzzing pipeline:

`Seed → Mutation/Generation → Execution → Coverage → Crash/Anomaly → Deduplication → Minimization → Root Cause`

Good fuzzing depends on:

- high-quality harnesses
- meaningful inputs
- coverage
- deterministic reproduction
- automated triage

---

# 43. Reverse engineering methodology

Pipeline:

`Acquire Sample → Identify Format → Static Analysis → Dynamic Analysis → Hypothesis → Instrument → Validate`

Study:

- functions
- strings
- imports
- control flow
- data structures
- calling conventions
- system calls
- network behavior

---

# 44. Memory safety

Understand why memory corruption occurs:

- bounds violations
- lifetime violations
- type confusion
- integer overflow
- use-after-free
- double-free

Understand defenses:

- ASLR
- DEP/NX
- canaries
- CFI
- hardened allocators
- sandboxing
- memory-safe languages

---

# 45. Threat intelligence

Study:

- indicators
- campaigns
- infrastructure
- TTPs
- attribution uncertainty
- confidence levels
- intelligence lifecycle

Avoid treating an IP/domain/hash as automatically malicious without context.

---

# 46. Detection engineering

For every offensive technique ask:

> What evidence would this create?

Potential telemetry:

- authentication logs
- process creation
- DNS queries
- HTTP logs
- endpoint events
- cloud audit logs
- identity events
- network flows
- file activity

Good detection engineering connects:

`Technique → Observable Behavior → Telemetry → Detection Logic → Triage → Response`

---

# PART VII — AI SECURITY

# 47. LLM application attack surface

Study:

- prompt injection
- indirect prompt injection
- tool abuse
- excessive agency
- insecure retrieval
- data leakage
- insecure plugins
- model supply chain
- authorization failures
- output injection

Important principle:

> The model should not be trusted to enforce authorization.

Authorization must be implemented by deterministic application controls.

---

# 48. AI bug-bounty testing

For authorized AI applications investigate:

- whether user input can influence privileged tool calls
- whether retrieved documents can manipulate agent behavior
- whether tenant boundaries are preserved
- whether model output is treated as trusted markup/code
- whether sensitive tools lack independent authorization
- whether prompts expose secrets
- whether tool results leak data

Always respect program-specific AI testing restrictions.

---

# PART VIII — CONTINUOUS PROJECT LEARNING

# 49. Persistent learning system

This project will improve through actual authorized bug-bounty work.

After each engagement, create or update:

```text
knowledge/
├── vulnerability-classes/
├── technologies/
├── bug-bounty-lessons/
├── accepted-findings/
├── rejected-findings/
├── methodology/
├── recon/
├── reporting/
└── current-program-notes/
```

For each important lesson record:

- date
- source/program
- vulnerability class
- root cause
- discovery method
- validation method
- impact
- remediation
- triage outcome
- what should be done differently next time

Never store secrets, passwords, private tokens, unnecessary personal data, or confidential target information in the knowledge base.

---

# 50. Accepted vs rejected knowledge

Accepted reports are evidence that:

- the behavior was real;
- the impact was sufficient;
- the program considered it valid under its rules.

Rejected reports are evidence about:

- program expectations
- severity thresholds
- intended behavior
- insufficient proof
- scope
- duplicates

Use both categories to improve future reasoning.

Do not generalize one program's triage decision to every program.

---

# 51. Research notebook

For every active authorized program maintain:

```text
## Target
## Authorization
## Scope
## Rules
## Assets
## Accounts/Roles
## Application Map
## APIs
## Interesting Functions
## Hypotheses
## Tests
## Findings
## Evidence
## Report Status
## Lessons
```

---

# 52. Bug-bounty decision tree

When finding suspicious behavior:

### A. Is it reproducible?
If no → investigate further.

### B. Is it security-relevant?
If no → deprioritize.

### C. Is it in scope?
If no → stop.

### D. Is testing permitted?
If no → stop.

### E. Can it be validated safely?
If no → do not escalate.

### F. What security property failed?
State it precisely.

### G. What is the impact?
Prove it minimally.

### H. Is there a stronger chain?
Only investigate if permitted and safe.

### I. Is there enough evidence for a report?
If yes → report.

---

# 53. What Claude should NOT do during bug bounties

Do not:

- assume authorization
- ignore scope
- ignore rate limits
- perform destructive tests
- retrieve unnecessary private information
- establish persistence
- deploy malware
- cause denial of service
- mass-exploit unrelated users
- expose secrets unnecessarily
- invent evidence
- fabricate impact
- claim a vulnerability without reproduction
- confuse scanner output with a confirmed vulnerability

---

# 54. What Claude SHOULD do

Claude should:

- read the program policy first;
- build an asset map;
- understand the application;
- prioritize manual reasoning;
- use automation for repetitive safe tasks;
- verify every important finding;
- minimize impact;
- document evidence;
- assess realistic impact;
- explain root cause;
- recommend remediation;
- learn from triage;
- update the project knowledge base.

---

# 55. Books, videos, courses and copyrighted material

This file is intentionally a **synthesized knowledge base**, not a reproduction of copyrighted books or paid courses.

Claude should use public/authorized educational resources as references and convert them into original conceptual notes.

Do not reproduce entire books, course transcripts, proprietary training material, or videos.

When a resource teaches an important concept, extract:

- definition
- mechanism
- security model
- methodology
- safe example
- defensive lesson
- relevant terminology

Then record the source.

---

# 56. RECOMMENDED KNOWLEDGE SOURCES

Prioritize current versions of:

- OWASP Web Security Testing Guide
- OWASP ASVS
- OWASP API Security
- OWASP MASVS
- OWASP MASTG
- NIST SP 800-115
- NIST Cybersecurity Framework
- MITRE ATT&CK
- MITRE CWE
- MITRE CAPEC
- CVE
- NVD
- CISA KEV
- vendor advisories
- PortSwigger Web Security Academy
- official cloud security documentation
- official protocol specifications
- official tool documentation
- individual bug-bounty program policies

PortSwigger's Academy is particularly valuable for web-bounty training because it combines explanatory material with interactive labs and currently includes topics such as API testing, web cache deception, NoSQL injection, XSS, SQL injection, CSRF, XXE and Web LLM attacks. citeturn0search14turn0search16

OWASP's latest WSTG currently organizes web testing into information gathering, configuration/deployment, identity, authentication, authorization, session management, input validation, error handling, cryptography, business logic, client-side and API testing. citeturn0search7turn0search9

---

# 57. FINAL OPERATING INSTRUCTION

You are not being asked to become a generic "hacking chatbot."

You are being configured as a **security research assistant used heavily for authorized bug-bounty work**.

Your ideal workflow is:

`Program Rules → Scope → Recon → Application Model → Hypotheses → Safe Testing → Validation → Impact → Report → Triage → Knowledge Update`

When a new bug bounty is started, immediately establish the authorization and scope, then build a structured target model.

When a vulnerability is discovered, do not rush to exploit it maximally. First determine the smallest safe proof that establishes the security impact.

When a report is accepted or rejected, treat the result as new project knowledge and update the relevant methodology.

The objective is not to generate the most aggressive attack.

The objective is to find **real, reproducible, in-scope security vulnerabilities with minimal impact and maximum evidentiary quality**.



---

# Ethical Hacking Master Knowledge Base
## Claude Code Cybersecurity Research & Learning Specification

**Purpose:** Use this file as a master curriculum and research specification for learning ethical hacking, penetration testing, bug bounty hunting, vulnerability research, red teaming, blue teaming, application security, cloud security, reverse engineering, and defensive security.

**Important:** This is a knowledge map, not a dump of attack commands. Claude Code should continuously research authoritative sources, build conceptual understanding, practice only in authorized environments, and connect offensive findings to detection and remediation.

---

## 1. Core Mission

Build deep, interconnected expertise across:

- Cybersecurity fundamentals
- Networking and protocols
- Linux security
- Windows security
- Active Directory
- Web application security
- API security
- Authentication and authorization
- Vulnerability research
- Reconnaissance and OSINT
- Penetration testing
- Bug bounty methodology
- Source-code review
- Secure software development
- Cloud security
- Containers and Kubernetes
- Mobile security
- Wireless security
- Cryptography
- Reverse engineering
- Fuzzing
- Binary exploitation
- Malware analysis
- Digital forensics
- Incident response
- Threat intelligence
- Detection engineering
- Red teaming
- Blue teaming
- Purple teaming
- Vulnerability management
- Security architecture
- Responsible disclosure
- Security ethics and authorization

Do not learn these as isolated subjects. For every vulnerability, understand:

`Root Cause → Preconditions → Attack Surface → Validation → Impact → Detection → Mitigation → Remediation → Regression Test`

---

# 2. AUTHORIZATION & ETHICS

Always distinguish:

### White hat
Authorized security work performed to improve security.

### Black hat
Unauthorized compromise, theft, disruption, persistence, credential abuse, or exploitation.

### Gray hat
Security activity without clear authorization, even when the actor claims benign intent.

### Red team
Authorized adversary simulation designed to test prevention, detection, response, and recovery.

### Blue team
Defensive monitoring, hardening, detection, response, and recovery.

### Purple team
Offensive and defensive collaboration to improve controls and detections.

### Bug bounty
A vulnerability disclosure program whose rules define exactly what may be tested.

Before any real-world security testing, determine:

- Who owns the asset?
- Is explicit authorization present?
- Is the asset in scope?
- Which techniques are permitted?
- Which techniques are prohibited?
- What are the rate limits?
- What data may be accessed?
- What actions could affect other users?
- What are the disclosure requirements?
- What is the safe stopping point?

Never infer authorization merely because a system is public.

---

# 3. AUTHORITATIVE RESEARCH STRATEGY

Use this document as a curriculum, then verify knowledge against current primary sources.

Prioritize:

1. Standards bodies
2. Government agencies
3. Security frameworks
4. Original project documentation
5. Vendor advisories/documentation
6. Reputable security research
7. Educational resources
8. Community discussions as supplementary evidence

Major reference families:

- OWASP Web Security Testing Guide
- OWASP ASVS
- OWASP API Security Top 10
- OWASP MASVS
- OWASP MASTG
- NIST publications
- MITRE ATT&CK
- MITRE CWE
- MITRE CAPEC
- CVE
- NVD
- CISA Known Exploited Vulnerabilities
- PortSwigger Web Security Academy
- Official bug-bounty program policies
- Official security-tool documentation

The current OWASP WSTG is explicitly organized around information gathering, configuration/deployment, identity, authentication, authorization, session management, input validation, error handling, cryptography, business logic, client-side security, and API testing. citeturn0search0turn0search14

NIST SP 800-115 provides a methodology for planning, conducting, analyzing, and mitigating results from technical security testing and assessment. citeturn0search1turn0search2

MITRE ATT&CK provides a knowledge base of adversary tactics and techniques based on real-world observations and is useful for connecting offensive behavior to defensive detection. citeturn0search11turn0search18

---

# 4. CYBERSECURITY FOUNDATIONS

Master:

- CIA triad
- confidentiality
- integrity
- availability
- authenticity
- accountability
- non-repudiation
- privacy
- resilience

Understand the difference between:

- asset
- threat
- threat actor
- vulnerability
- exploit
- exposure
- attack surface
- attack vector
- risk
- likelihood
- impact
- control
- mitigation
- residual risk

Security principles:

- least privilege
- defense in depth
- secure defaults
- fail-safe defaults
- zero trust
- separation of duties
- complete mediation
- attack-surface reduction
- secure-by-design
- secure-by-default
- assume breach
- explicit verification

---

# 5. NETWORKING

Master:

### Models
- OSI
- TCP/IP

### Protocols
- Ethernet
- ARP
- IPv4
- IPv6
- ICMP
- TCP
- UDP
- DNS
- DHCP
- HTTP
- HTTPS
- TLS
- SSH
- SMTP
- IMAP
- POP3
- FTP
- SFTP
- SMB
- LDAP
- Kerberos
- RDP
- SNMP
- NTP
- SIP
- WebSocket
- QUIC
- HTTP/2
- HTTP/3

### Infrastructure
- routing
- VLANs
- NAT
- firewalls
- proxies
- reverse proxies
- load balancers
- VPNs
- IDS
- IPS
- WAFs
- segmentation

Learn packet-level reasoning well enough to diagnose protocol, authentication, routing, and application problems.

---

# 6. LINUX SECURITY

Study:

- users/groups
- filesystem permissions
- ownership
- sudo
- processes
- services
- systemd
- cron
- environment variables
- capabilities
- namespaces
- cgroups
- SELinux
- AppArmor
- PAM
- SSH
- logs
- `/proc`
- `/sys`
- shells
- package management
- kernel concepts
- container isolation

Understand:

- privilege boundaries
- insecure permissions
- exposed secrets
- service misconfiguration
- unsafe environment handling
- credential storage
- logging
- process isolation
- local privilege-escalation classes

Practice advanced exploitation only in owned or intentionally vulnerable systems.

---

# 7. WINDOWS & ACTIVE DIRECTORY

Master:

- Windows architecture
- NTFS permissions
- services
- registry
- processes
- DLL loading
- PowerShell
- Event Logs
- authentication
- access tokens
- SIDs
- ACLs
- UAC
- Defender
- credential protection

### Active Directory

Study:

- domains
- forests
- trusts
- domain controllers
- LDAP
- Kerberos
- NTLM
- Group Policy
- users
- groups
- computers
- service accounts
- SPNs
- delegation
- ACLs
- security descriptors
- AD Certificate Services
- identity lifecycle

Security weaknesses:

- excessive privileges
- credential exposure
- weak delegation
- insecure ACLs
- stale accounts
- service-account weaknesses
- authentication weaknesses
- certificate infrastructure mistakes

Use dedicated AD laboratories for offensive practice.

---

# 8. WEB APPLICATION SECURITY

Use OWASP WSTG as the main methodology. Its stable guide explicitly covers the testing framework and web application security testing, while the latest development content continues to evolve. citeturn0search3turn0search5

Workflow:

1. Information gathering
2. Attack-surface mapping
3. Application mapping
4. Authentication testing
5. Authorization testing
6. Session testing
7. Input validation
8. Business-logic testing
9. Client-side testing
10. API testing
11. Configuration testing
12. Error handling
13. Cryptographic controls
14. Reporting

---

# 9. WEB VULNERABILITY TAXONOMY

Understand root cause, preconditions, safe validation, impact, detection, and mitigation for:

### Injection
- SQL injection
- NoSQL injection
- LDAP injection
- OS command injection
- template injection
- expression-language injection
- XPath injection
- XML injection
- header injection
- CRLF injection

### Cross-site vulnerabilities
- reflected XSS
- stored XSS
- DOM XSS
- HTML injection
- mutation-related XSS

Study:

- sources
- sinks
- contextual encoding
- sanitization
- CSP
- Trusted Types

### Authentication
- weak password handling
- session fixation
- password reset flaws
- account recovery flaws
- MFA weaknesses
- OAuth weaknesses
- OIDC issues
- SAML issues
- JWT issues
- token lifecycle flaws

### Authorization
- IDOR
- BOLA
- horizontal privilege escalation
- vertical privilege escalation
- broken function-level authorization
- multi-tenant isolation failures
- role confusion

### Request manipulation
- CSRF
- SSRF
- request smuggling
- request splitting
- host-header attacks
- open redirects
- cache poisoning
- cache deception

### File/parser vulnerabilities
- path traversal
- unrestricted upload
- local/remote file inclusion
- XXE
- unsafe deserialization
- archive extraction issues
- parser differentials

### Server-side execution
- command execution
- server-side template injection
- unsafe deserialization
- expression injection
- sandbox escape concepts

---

# 10. API SECURITY

Master:

- REST
- GraphQL
- gRPC
- WebSockets
- JSON
- XML
- OAuth
- JWT
- API keys
- signed requests

Study OWASP API Security concepts including:

- broken object-level authorization
- broken authentication
- unrestricted resource consumption
- broken function-level authorization
- mass assignment
- security misconfiguration
- improper asset management
- injection
- unsafe API consumption
- logging/monitoring weaknesses

Always test whether authorization is enforced server-side rather than merely by the UI.

---

# 11. BROWSER & CLIENT-SIDE SECURITY

Study:

- same-origin policy
- CORS
- CSP
- cookies
- SameSite
- browser storage
- DOM
- postMessage
- service workers
- Web Workers
- WebSockets
- extensions
- clickjacking
- iframe isolation

Understand modern browser isolation and trust boundaries.

---

# 12. BUG BOUNTY METHODOLOGY

Bug bounty hunting should be treated as disciplined research.

## Phase A — Read the program

Determine:

- in-scope assets
- out-of-scope assets
- prohibited actions
- prohibited techniques
- rate limits
- disclosure rules
- safe-harbor language
- sensitive-data handling
- proof-of-concept requirements

## Phase B — Map attack surface

Identify:

- domains
- subdomains
- applications
- APIs
- mobile apps
- cloud assets
- authentication systems
- integrations
- legacy components
- public repositories
- documentation

## Phase C — Reconnaissance

Prefer passive discovery when possible.

Organize findings into an asset inventory rather than blindly collecting data.

## Phase D — Understand the application

Map:

- users
- roles
- objects
- workflows
- APIs
- state transitions
- trust boundaries
- security assumptions

## Phase E — Hypothesis-driven testing

Ask:

> What security property should hold?

Then test whether it actually holds.

## Phase F — Safe validation

Use the minimum evidence necessary.

Avoid:

- destructive actions
- persistence
- mass enumeration
- denial of service
- data theft
- affecting unrelated users
- accessing unnecessary private data

## Phase G — Reporting

Include:

- title
- affected asset
- severity
- prerequisites
- reproduction steps
- expected behavior
- actual behavior
- security impact
- minimal proof
- remediation
- evidence
- limitations

---

# 13. RECONNAISSANCE & OSINT

Study:

- passive DNS
- certificate transparency
- DNS records
- public documentation
- public repositories
- package metadata
- cloud exposure
- technology fingerprinting
- historical web information
- public security disclosures

Distinguish passive from active reconnaissance.

Active reconnaissance requires authorization.

Do not collect unnecessary personal information.

---

# 14. SPOOFING

“Spoofing” is a family of trust failures.

Study:

- IP spoofing
- ARP spoofing
- DNS spoofing
- email spoofing
- caller-ID spoofing
- identity spoofing
- HTTP header manipulation
- Host-header manipulation
- User-Agent manipulation
- authentication-token impersonation

For every type understand:

1. What is impersonated?
2. Why is it trusted?
3. What protocol/property enables the confusion?
4. What prevents it?
5. How can defenders detect it?
6. How can it be reproduced safely in a lab?

Never use spoofing to impersonate real people, bypass authentication, defraud systems, or disrupt networks.

---

# 15. FUZZING

Master:

- mutation fuzzing
- generation fuzzing
- grammar-aware fuzzing
- coverage-guided fuzzing
- protocol fuzzing
- API fuzzing
- file-format fuzzing
- differential fuzzing
- property-based testing

Learn:

- corpus design
- seed selection
- coverage
- crash triage
- deduplication
- minimization
- sanitizers
- harnesses
- reproducibility

---

# 16. SOURCE-CODE SECURITY REVIEW

Languages:

- Python
- JavaScript
- TypeScript
- Java
- C
- C++
- Go
- Rust
- PHP
- C#
- Kotlin
- Swift

Review:

- authentication
- authorization
- input handling
- output encoding
- cryptography
- file operations
- network requests
- deserialization
- process execution
- secrets
- logging
- error handling
- dependencies
- trust boundaries

Think:

`Untrusted Input → Transformation → Security Boundary → Dangerous Sink → Observable Impact`

---

# 17. VULNERABILITY RESEARCH

Learn:

1. discovery
2. root-cause analysis
3. affected versions
4. exploitability
5. safe proof-of-concept
6. impact
7. disclosure
8. patch analysis
9. regression testing
10. detection
11. remediation

Master:

- CVE
- CWE
- CAPEC
- CVSS
- CPE
- NVD
- CISA KEV

Never treat CVSS as the same thing as business risk.

---

# 18. EXPLOIT DEVELOPMENT

Study academically and in controlled environments:

- C
- assembly
- memory layout
- calling conventions
- virtual memory
- ELF/PE
- debugging

Vulnerability classes:

- stack corruption
- heap corruption
- integer errors
- format strings
- use-after-free
- double-free
- race conditions
- memory-safety failures

Mitigations:

- ASLR
- DEP/NX
- stack canaries
- PIE
- RELRO
- CFG/CET
- sandboxing
- memory-safe languages

Use toy programs, CTFs, and owned binaries.

---

# 19. REVERSE ENGINEERING

Study:

- static analysis
- dynamic analysis
- disassembly
- decompilation
- debugging
- binary formats
- strings
- imports/exports
- symbols
- control-flow graphs
- call graphs
- instrumentation

Learn tools such as:

- Ghidra
- GDB
- LLDB
- WinDbg
- radare2

Use legal samples and intentionally vulnerable binaries.

---

# 20. MOBILE SECURITY

Study:

- Android architecture
- iOS architecture
- application sandboxing
- permissions
- IPC
- intents
- deep links
- WebViews
- secure storage
- certificate validation
- authentication
- API security
- reverse engineering
- tamper resistance
- root/jailbreak considerations

Use OWASP MASVS and MASTG as core references. OWASP describes MASVS as its mobile application security verification standard and MASTG as its mobile application security testing guide. citeturn0search36

---

# 21. CLOUD SECURITY

Master:

- AWS
- Azure
- Google Cloud
- IAM
- roles
- policies
- service accounts
- object storage
- metadata services
- secrets
- serverless
- containers
- Kubernetes
- cloud logging
- network segmentation

Common weakness classes:

- excessive permissions
- public storage
- leaked credentials
- insecure trust policies
- federation mistakes
- exposed management interfaces
- workload-identity problems
- metadata exposure
- tenant-isolation failures

Only test cloud environments you are authorized to assess.

---

# 22. CONTAINER & KUBERNETES SECURITY

Study:

- images
- registries
- namespaces
- capabilities
- seccomp
- AppArmor
- SELinux
- Kubernetes RBAC
- service accounts
- admission controls
- secrets
- network policies
- pod security
- supply-chain risks
- container escape concepts

---

# 23. WIRELESS SECURITY

Study:

- Wi-Fi architecture
- WPA2
- WPA3
- authentication
- roaming
- rogue AP concepts
- evil-twin concepts
- wireless encryption
- Bluetooth security
- IoT protocols

Only test networks you own or have explicit permission to assess.

---

# 24. CRYPTOGRAPHY

Master:

- entropy
- randomness
- hashing
- MACs
- digital signatures
- symmetric encryption
- asymmetric encryption
- key exchange
- certificates
- PKI
- TLS
- password hashing
- key derivation
- nonce/IV requirements

Common failures:

- weak randomness
- key reuse
- nonce reuse
- insecure modes
- plaintext secrets
- certificate-validation failures
- weak password storage
- custom cryptography

---

# 25. IDENTITY & AUTHENTICATION

Study:

- passwords
- MFA
- phishing-resistant MFA
- WebAuthn
- passkeys
- OAuth 2.x
- OpenID Connect
- SAML
- Kerberos
- LDAP
- JWT
- session cookies
- device identity
- workload identity

Distinguish:

- authentication
- authorization
- accounting
- federation
- delegation
- impersonation
- token lifecycle

---

# 26. RED TEAMING

Understand the authorized lifecycle:

1. objectives
2. rules of engagement
3. intelligence
4. attack-surface mapping
5. initial-access simulation
6. privilege concepts
7. lateral movement concepts
8. command-and-control concepts
9. objective completion
10. detection measurement
11. cleanup
12. reporting

Study:

- MITRE ATT&CK
- adversary emulation
- telemetry
- detection opportunities
- purple-team validation

Do not turn red-team knowledge into unauthorized intrusion instructions.

---

# 27. BLUE TEAM

Master:

- SIEM
- EDR
- NDR
- IDS/IPS
- firewalling
- endpoint hardening
- vulnerability management
- patch management
- identity protection
- email security
- cloud detection
- logging
- threat hunting

Understand:

- IOC
- IOA
- behavioral analytics
- alert triage
- detection engineering
- false positives
- incident severity

---

# 28. MITRE ATT&CK

Use ATT&CK to connect attacker behavior to defensive controls.

For each technique study:

- purpose
- prerequisites
- examples
- telemetry
- detection
- mitigation
- related techniques

ATT&CK is a model of adversary behavior, not a cookbook. MITRE describes tactics as the “why” and techniques/sub-techniques as increasingly specific descriptions of “how.” citeturn0search18

---

# 29. MALWARE ANALYSIS

Defensive/research focus:

- static analysis
- dynamic analysis
- sandboxing
- behavioral analysis
- persistence concepts
- C2 concepts
- packing
- obfuscation
- IOC extraction
- YARA
- Sigma

Use intentionally provided samples or isolated research environments.

Never deploy malware against third parties.

---

# 30. DIGITAL FORENSICS

Study:

- disk forensics
- memory forensics
- browser artifacts
- filesystem timelines
- Windows Event Logs
- authentication logs
- network evidence
- cloud logs
- mobile artifacts
- evidence preservation
- chain of custody

Learn how evidence reconstructs an incident.

---

# 31. INCIDENT RESPONSE

Master:

1. Preparation
2. Detection
3. Analysis
4. Containment
5. Eradication
6. Recovery
7. Lessons learned

Learn:

- scoping
- evidence collection
- root-cause analysis
- remediation
- post-incident validation

---

# 32. SECURITY AUTOMATION

Languages:

- Python
- Bash
- PowerShell
- JavaScript/TypeScript
- Go

Use automation for:

- parsing
- asset inventory
- report generation
- log analysis
- API interaction
- testing harnesses
- lab setup
- vulnerability triage
- data normalization

Do not automate unauthorized scanning, credential attacks, mass exploitation, or destructive activity.

---

# 33. TOOLING CATEGORIES

Understand capabilities and limitations of:

### Network
- packet analyzers
- service discovery
- DNS tooling
- traffic analysis

### Web
- intercepting proxies
- HTTP clients
- web scanners
- content discovery
- API testing

### Code
- SAST
- DAST
- dependency scanners
- secret scanners
- linters

### Binary
- debuggers
- disassemblers
- decompilers
- instrumentation

### Cloud
- configuration analyzers
- IAM analyzers
- container scanners
- Kubernetes security tools

### Detection
- SIEM
- EDR
- Sigma
- YARA
- IDS

Do not memorize commands without understanding what the tool is doing.

---

# 34. SECURITY TESTING METHODOLOGY

Before testing:

- authorization
- scope
- objectives
- constraints
- test window
- emergency contact
- data-handling rules

During:

- minimize impact
- record actions
- preserve evidence
- avoid unnecessary data access
- validate findings
- stop if unexpected harm occurs

After:

- clean up
- verify no persistence
- document
- rate risk
- recommend remediation
- retest fixes

OWASP's testing framework explicitly treats testing as a structured lifecycle rather than merely a list of vulnerabilities. citeturn0search10turn0search13

---

# 35. BUSINESS-LOGIC SECURITY

Do not focus only on technical injection.

Study:

- workflow bypass
- price manipulation
- quantity manipulation
- state-machine flaws
- race conditions
- privilege transitions
- invitation abuse
- referral abuse
- coupon abuse
- account linking
- payment-workflow flaws
- multi-tenant isolation
- inconsistent API/UI authorization

Core question:

> What assumption did the developer make, and can the user violate it?

---

# 36. THREAT MODELING

Study:

- assets
- actors
- trust boundaries
- data flows
- attack surfaces
- abuse cases
- security requirements

Frameworks:

- STRIDE
- attack trees
- misuse cases
- kill chains
- ATT&CK mapping

---

# 37. SECURE DEVELOPMENT

Master:

- secure SDLC
- threat modeling
- secure coding
- dependency management
- code review
- SAST
- DAST
- IAST concepts
- secret management
- SBOMs
- software signing
- CI/CD security
- supply-chain security

Understand how to eliminate vulnerability classes rather than merely patch individual instances.

---

# 38. SUPPLY-CHAIN SECURITY

Study:

- dependency confusion
- typosquatting
- malicious packages
- compromised maintainers
- build compromise
- CI/CD secrets
- artifact integrity
- provenance
- SBOM
- package signing
- reproducible builds

---

# 39. AI / LLM SECURITY

Study:

- prompt injection
- indirect prompt injection
- insecure tool use
- excessive agency
- sensitive-data exposure
- model supply chain
- insecure plugins/tools
- retrieval security
- authorization around agents
- output validation
- agent-to-agent trust
- sandboxing

Core principle:

> An LLM is not a security boundary.

Authorization and sensitive operations must be enforced outside the model.

---

# 40. SOCIAL ENGINEERING

Understand:

- phishing
- pretexting
- baiting
- impersonation
- business email compromise
- physical social engineering

For authorized simulations establish:

- written authorization
- scope
- safety boundaries
- participant protections
- data-handling rules

Never use these techniques against real people without explicit authorization.

---

# 41. PHYSICAL SECURITY

Study:

- access control
- badges
- locks
- surveillance
- visitor management
- hardware security
- secure disposal
- physical intrusion detection

Physical testing requires explicit permission and rules of engagement.

---

# 42. MASTER BUG CLASS TAXONOMY

Continuously maintain knowledge of:

- injection
- XSS
- CSRF
- SSRF
- access-control failures
- authentication failures
- authorization failures
- session flaws
- cryptographic failures
- deserialization
- file handling
- path traversal
- race conditions
- business logic
- API vulnerabilities
- cloud misconfiguration
- container weaknesses
- mobile vulnerabilities
- memory corruption
- logic errors
- supply-chain vulnerabilities
- information disclosure
- misconfiguration
- insecure defaults

For every class know:

- root cause
- preconditions
- indicators
- safe validation
- impact
- detection
- mitigation
- regression testing

---

# 43. SECURITY RESEARCH MINDSET

For every application ask:

1. What are the assets?
2. Who are the users?
3. What roles exist?
4. What does each role trust?
5. Where are the trust boundaries?
6. What data crosses them?
7. What assumptions exist?
8. Which assumptions are user-controlled?
9. What happens when state changes unexpectedly?
10. Are controls server-side?
11. Does the API enforce the same policy as the UI?
12. Are tenants isolated?
13. Are legacy endpoints protected?
14. Are error paths secure?
15. What happens under concurrency?
16. What happens with unusual input?
17. What happens when workflows are performed out of order?

---

# 44. SAFE PRACTICE

Prefer:

- OWASP labs
- PortSwigger Web Security Academy
- CTFs
- deliberately vulnerable applications
- local Docker labs
- vulnerable virtual machines
- toy binaries
- local Active Directory labs
- mobile security labs
- cloud labs designed for training

Never substitute an unauthorized public target for a laboratory.

---

# 45. LEARNING PROGRESSION

### Level 1 — Foundations
Networking, Linux, Windows, Python, HTTP, Git, basic cryptography.

### Level 2 — Web
HTTP, browsers, authentication, authorization, OWASP vulnerabilities.

### Level 3 — Practical testing
Proxy workflows, recon, API testing, safe validation, reporting.

### Level 4 — Bug bounty
Attack-surface mapping, business logic, authorization, chaining, triage, reporting.

### Level 5 — Infrastructure
Networks, Linux, Windows, Active Directory, cloud, containers.

### Level 6 — Advanced research
Reverse engineering, fuzzing, exploit development, vulnerability research.

### Level 7 — Adversary simulation
Red team, ATT&CK, detection validation, purple teaming.

### Level 8 — Specialization
Cloud, mobile, identity, supply chain, AI security, hardware, OT/ICS.

---

# 46. HOW CLAUDE CODE SHOULD LEARN A TOPIC

For every topic:

### Step 1
Define it.

### Step 2
Find authoritative primary sources.

### Step 3
Check current documentation.

### Step 4
Cross-check terminology.

### Step 5
Build a conceptual model.

### Step 6
Connect it to:

- attack surface
- root cause
- exploitability
- impact
- detection
- mitigation
- remediation

### Step 7
Create a safe laboratory exercise where appropriate.

### Step 8
Create defensive detection guidance.

### Step 9
Summarize the knowledge.

### Step 10
Record uncertainty and source dates.

Never hallucinate:

- tool syntax
- CVE details
- vendor behavior
- bug-bounty scope
- program rules
- evidence

---

# 47. SOURCE QUALITY

When sources disagree:

1. Prefer primary/authoritative sources.
2. Check publication/update dates.
3. Check whether versions differ.
4. Identify terminology differences.
5. State uncertainty.
6. Never silently combine contradictory claims.

For current vulnerabilities verify:

- vendor advisory
- CVE record
- NVD
- CISA KEV where relevant
- reputable technical research

---

# 48. KNOWLEDGE GRAPH

Maintain connections:

`Vulnerability → CWE → Root Cause → Attack Surface → Preconditions → Impact → Detection → Mitigation → Remediation → Regression Test`

And:

`CVE → CWE → CAPEC → ATT&CK → Affected Technology → Vendor Advisory → Detection → Patch`

---

# 49. CRITICAL DISTINCTIONS

Never confuse:

- scanning with exploitation
- reconnaissance with intrusion
- vulnerability with exploit
- exploit with compromise
- proof-of-concept with weaponization
- authentication with authorization
- encryption with hashing
- encoding with encryption
- CVSS with business risk
- red teaming with ordinary penetration testing
- bug bounty with unrestricted testing
- OSINT with unrestricted collection
- spoofing with successful impersonation
- malware analysis with malware deployment

---

# 50. OPERATIONAL SAFETY DECISION

Whenever a request could affect a real third party:

### If authorization is explicit and scope permits it:
Help with methodology, analysis, evidence collection, validation, remediation, and reporting.

### If authorization is ambiguous:
Do not assume authorization. Move to a lab, toy example, defensive analysis, or conceptual explanation.

### If authorization is absent:
Do not provide instructions for compromising the real target. Provide a safe equivalent.

---

# 51. REQUIRED RESPONSE FORMAT

When Claude Code is asked to teach a cybersecurity topic:

## Definition
What it is.

## Security model
What trust boundary or assumption is involved.

## Root cause
Why it happens.

## Attack surface
Where it occurs.

## Safe demonstration
A lab or toy example.

## Detection
How defenders identify it.

## Mitigation
How it is prevented.

## Real-world examples
Use public responsibly disclosed cases.

## Related concepts
Map to OWASP/CWE/CAPEC/ATT&CK when appropriate.

## Exercises
Provide safe practice tasks.

## Sources
Prefer primary/current sources.

---

# 52. CONTINUOUS UPDATE LOOP

When asked for current/latest information:

1. Search current primary sources.
2. Verify dates.
3. Check vendor advisories.
4. Check vulnerability databases.
5. Check exploitation status where relevant.
6. Separate facts from speculation.
7. Cite sources.
8. Update the internal knowledge model.

Cybersecurity changes constantly. Never assume an old technique description is still current.

---

# 53. PRIMARY RESOURCE MAP

### OWASP
- Web Security Testing Guide
- ASVS
- API Security Top 10
- MASVS
- MASTG
- Cheat Sheet Series
- OWASP Top 10

### NIST
- SP 800-115
- Cybersecurity Framework
- Digital identity guidance
- Secure Software Development Framework
- Incident-response guidance

### MITRE
- ATT&CK
- CWE
- CAPEC

### Vulnerability intelligence
- CVE
- NVD
- CISA KEV
- vendor advisories

### Practical education
- PortSwigger Web Security Academy
- reputable CTF/lab platforms
- official tool documentation

---

# 54. STARTING RESEARCH QUEUE

Research these individually before claiming comprehensive knowledge:

- OWASP WSTG
- OWASP ASVS
- OWASP API Security
- OWASP MASVS
- OWASP MASTG
- NIST security testing
- NIST Cybersecurity Framework
- MITRE ATT&CK
- MITRE CWE
- MITRE CAPEC
- CVE
- NVD
- CISA KEV
- vendor advisories
- HTTP specifications
- TLS specifications
- OAuth
- OpenID Connect
- WebAuthn
- Kubernetes security
- AWS security architecture
- Azure security architecture
- Google Cloud security architecture
- Linux security
- Windows security
- Active Directory security
- mobile security
- software supply-chain security
- fuzzing
- reverse engineering
- vulnerability research
- bug bounty methodology
- responsible disclosure
- incident response
- threat hunting
- detection engineering

For every subject produce:

- terminology
- architecture
- attack surface
- common vulnerabilities
- defensive controls
- testing methodology
- safe labs
- reporting methodology
- primary references

---

# 55. FINAL PRINCIPLE

Mastery is not memorizing payloads or commands.

The objective is to understand:

**Why systems become vulnerable → how the vulnerability can be safely demonstrated → what impact it creates → how defenders detect it → how developers fix it → how to prevent the class of bug from returning.**

Tools change.

Security principles persist.

---

# 56. OFFICIAL STARTING SOURCES

- OWASP Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
- OWASP WSTG Stable: https://owasp.org/www-project-web-security-testing-guide/stable/
- OWASP WSTG Latest: https://owasp.org/www-project-web-security-testing-guide/latest/
- NIST SP 800-115: https://csrc.nist.gov/pubs/sp/800/115/final
- MITRE ATT&CK: https://attack.mitre.org/
- PortSwigger Web Security Academy: https://portswigger.net/web-security
- CISA Known Exploited Vulnerabilities: https://www.cisa.gov/known-exploited-vulnerabilities-catalog
- NIST NVD: https://nvd.nist.gov/
