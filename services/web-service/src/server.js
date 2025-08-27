// services/web-service/src/server.js
const app = require('./app');
const port = process.env.PORT || 3001;

const server = app.listen(port, () => {
  console.log(`Web service running on port ${port}`);
});