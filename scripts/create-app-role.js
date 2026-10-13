'use strict';
// Used for a fresh external/CI database. Does not change an existing role's password.
const cfg = require('../server/config');
const { Pool } = require('pg');
(async()=>{
  const pool=new Pool({...cfg.pg,connectionString:process.env.MIGRATION_DATABASE_URL||undefined,user:process.env.PGADMIN_USER||cfg.pg.user,password:process.env.PGADMIN_PASSWORD||cfg.pg.password,max:1});
  try {
    const found=await pool.query('select 1 from pg_roles where rolname=$1',[cfg.pg.user]);
    if(!found.rows.length) {
      const statement=(await pool.query("select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) as sql",[cfg.pg.user,cfg.pg.password])).rows[0].sql;
      await pool.query(statement);
    }
    console.log('Application role ready: '+cfg.pg.user);
  } finally {await pool.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});

