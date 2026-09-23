# Repository Split

MotorBaldi Website owns public marketing pages, SEO assets, legal public pages, legacy PHP endpoints, HubSpot lead capture, Wompi marketing checkout experiments and FTP hosting workflows.

MotorBaldi Platform owns transactional API, portal, admin, workers, D1 schema, R2 storage metadata, Queues transport, Durable Object coordination, auth foundation, authorization, observability, tests, CI and infrastructure configuration templates.

Future lead capture flow:

Website -> MotorBaldi API -> MotorBaldi native CRM.

CRM and business domains are intentionally not implemented in CF-0.
