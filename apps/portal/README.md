# Portal Worker

The Portal is a Spanish first Foundation shell. Browser API calls use relative `/api/*` paths; the Worker forwards them through the `API_SERVICE` service binding. This keeps cookies and browser traffic same origin without giving the Portal D1, R2, or authentication secrets.
