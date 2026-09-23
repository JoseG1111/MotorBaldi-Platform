# ADR 0021 - Repository Split

Status: Accepted.

The Platform repository excludes website-only pages, marketing assets, HubSpot PHP bridge, FTP deployment and marketing QA artifacts from active runtime.

The Website repository remains responsible for public marketing and will call Platform APIs in future phases.
