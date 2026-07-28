# Contributor License Agreement (CLA)

> **In effect from v0.3.0 for engine contributions.**
>
> Adapted from the widely-used Apache Individual Contributor License Agreement.
> It has not yet been reviewed by a lawyer; it is published as-is, in plain
> sight, so you can judge the terms yourself — do not rely on it as legal advice.
>
> **The grantee ("We"/"Us") is the Project's maintainer: the individual who
> operates as [`2nd1st`](https://github.com/2nd1st) on GitHub.** The Project has
> no company behind it today; §9 (Assignment) is what carries this Agreement
> intact if that changes — a successor entity gains nothing beyond what You have
> already granted here.
>
> Contributions to `components/` need no agreement at all (MIT in, MIT out). DCO
> sign-off (`git commit -s`) applies to everything either way.
>
> This is the individual (ICLA) form. Contributing on behalf of an employer?
> Open an issue first — a corporate CLA (CCLA) is executed case by case until a
> standing one is published.

---

Thank you for your interest in contributing to open-mcp-apps (the "Project"),
maintained by the individual operating as `2nd1st` on GitHub ("We" or "Us";
see Section 9 for assignment to a successor). This Contributor License Agreement ("Agreement")
documents the rights granted by contributors to Us. By making a Contribution to
the Project, You accept and agree to the following terms for Your present and
future Contributions.

## 1. Definitions

**"You"** (or **"Your"**) means the individual copyright owner who submits a
Contribution to Us, or the legal entity authorized to submit on behalf of that
owner.

**"Contribution"** means any original work of authorship, including any
modifications or additions to an existing work, that is intentionally submitted
by You to Us for inclusion in, or documentation of, the Project. "Submitted"
means any form of electronic, verbal, or written communication sent to Us or our
representatives, including but not limited to communication on source-code
control systems and issue-tracking systems managed by, or on behalf of, Us, but
excluding communication conspicuously marked or otherwise designated in writing
by You as "Not a Contribution."

**Scope.** This Agreement covers Contributions to the **engine** — that is,
everything outside the `components/` directory, which is licensed separately
under the MIT License (see [`LICENSING.md`](LICENSING.md)). Contributions to
`components/` are governed by that MIT License alone and require no agreement
with Us.

## 2. Grant of Copyright License

Subject to the terms of this Agreement, You grant to Us and to recipients of
software distributed by Us a **perpetual, worldwide, non-exclusive, no-charge,
royalty-free, irrevocable** copyright license to reproduce, prepare derivative
works of, publicly display, publicly perform, sublicense, and distribute Your
Contributions and such derivative works.

## 3. Grant of Patent License

Subject to the terms of this Agreement, You grant to Us and to recipients of
software distributed by Us a perpetual, worldwide, non-exclusive, no-charge,
royalty-free, irrevocable (except as stated in this section) patent license to
make, have made, use, offer to sell, sell, import, and otherwise transfer the
Project, where such license applies only to those patent claims licensable by
You that are necessarily infringed by Your Contribution alone or by combination
of Your Contribution with the Project to which it was submitted. If any entity
institutes patent litigation against You or any other entity alleging that Your
Contribution, or the Project to which You contributed, constitutes direct or
contributory patent infringement, then any patent licenses granted to that
entity under this Agreement for that Contribution or Project shall terminate as
of the date such litigation is filed.

## 4. Right to Relicense

You acknowledge and agree that We may license the Project, including Your
Contributions, under **any license terms We choose**, including both open-source
licenses (such as the GNU Affero General Public License and the MIT License under
which the Project is currently distributed) **and proprietary or commercial
licenses**, and that We may offer the Project — including Your Contributions — as
part of a hosted or commercial service. This right is the purpose of this
Agreement: it lets the Project remain available under a copyleft license to the
public while allowing Us to sustain it, including by embedding it in Our own
hosted service. The license You grant Us in Sections 2 and 3 is non-exclusive —
You retain all right, title, and interest in Your Contributions and may use them
for any other purpose.

## 5. Your Representations

You represent that:

(a) You are legally entitled to grant the above licenses. If Your employer(s)
have rights to intellectual property that You create, You represent that You
have received permission to make the Contributions on behalf of that employer,
that Your employer has waived such rights for Your Contributions to Us, or that
Your employer has executed a separate corporate CLA with Us.

(b) Each of Your Contributions is Your original creation (see Section 7 for
submissions on behalf of others).

(c) Your Contribution does not, to Your knowledge, violate any third party's
copyrights, trademarks, patents, or other intellectual property rights.

## 6. Disclaimer

You are not expected to provide support for Your Contributions, except to the
extent You desire to provide support. Unless required by applicable law or
agreed to in writing, You provide Your Contributions on an **"AS IS"** basis,
without warranties or conditions of any kind, either express or implied,
including, without limitation, any warranties or conditions of title,
non-infringement, merchantability, or fitness for a particular purpose.

## 7. Submissions on Behalf of Others

Should You wish to submit work that is not Your original creation, You may submit
it to Us separately from any Contribution, identifying the complete details of
its source and of any license or other restriction (including, but not limited
to, related patents, trademarks, and license agreements) of which You are
personally aware, and conspicuously marking the work as "Submitted on behalf of
a third-party: [named here]".

## 8. Notification

You agree to notify Us of any facts or circumstances of which You become aware
that would make these representations inaccurate in any respect.

## 9. Assignment

We may assign this Agreement, and the rights granted under it, to a successor
that continues the Project — including an entity We later form or that acquires
the Project — provided the successor assumes Our obligations under it. This is
what keeps the Agreement intact if the Project moves from an individual
maintainer to a company; it grants the successor nothing beyond what You have
already granted here, and Your own rights in Your Contributions are unaffected.

---

## How to sign

Signing happens on your FIRST pull request, in the PR itself: the CLA check
prompts you, and you sign by replying with a comment —

> I have read the CLA Document and I hereby sign the CLA

The signature is recorded once against your GitHub identity (in
`.github/cla-signatures.json` on `main`) and every later PR passes the check
automatically. Maintainer and bot accounts are allowlisted. DCO sign-off
(`git commit -s`) is still required on every commit — the CLA covers the grant,
the sign-off covers each change's provenance.
