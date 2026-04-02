// DB-Abstraktionsschicht – Factory
// DB_BACKEND=sqlite (default) oder nocodb
const backend = process.env.DB_BACKEND || 'sqlite';
module.exports = require(`./${backend}`);
