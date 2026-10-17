/* SQLite 3.54.0 public-domain source excerpts from sqlite.org/sqlite3.c.
 * Source ID: be8d059e9a49089ab2dce5ed26dd87aaf598fdc5fbe0b107c0dd758464bcd5e3.
 * Selected API/state-machine bodies are verbatim excerpts with #line provenance.
 * The ASCII comparison, logging and callback environment is independently implemented.
 * This executable is a trusted, isolated oracle, not an execution of an analyzed
 * SQLite image. Logging and mutex callbacks are concrete observable environment
 * implementations; no product prototype is supplied to the decompiler. */
#define NDEBUG 1
#include <assert.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#define SQLITE_API __attribute__((noinline))
#define SQLITE_PRIVATE __attribute__((noinline))
#define SQLITE_ENABLE_API_ARMOR 1
#define SQLITE_ASCII 1
#define SQLITE_MISUSE 21
#define SQLITE_EMPTY 16
#define SQLITE_NOMEM_BKPT 7
#define SQLITE_STATE_OPEN 0x76
#define SQLITE_STATE_SICK 0xba
#define SQLITE_STATE_BUSY 0x6d
#define SQLITE_N_LIMIT 15
#define SQLITE_MIN_LENGTH 30
#define SQLITE_LIMIT_LENGTH 0
#define testcase(X) ((void)0)
#define SQLITE_MISUSE_BKPT sqlite3MisuseError(__LINE__)
#define tkSEMI 0
#define tkWS 1
#define tkOTHER 2
#define tkEXPLAIN 3
#define tkCREATE 4
#define tkTEMP 5
#define tkTRIGGER 6
#define tkEND 7

typedef uint8_t u8;
typedef uint32_t u32;
typedef uint64_t u64;
typedef int64_t i64;
typedef int64_t sqlite3_int64;
typedef struct sqlite3_mutex { unsigned identity; } sqlite3_mutex;
/* Only the source-accessed prefix is represented, not a claimed complete DB. */
typedef struct sqlite3 {
  void *pVfs, *pVdbe, *pDfltColl;
  sqlite3_mutex *mutex;
  void *aDb;
  int nDb;
  u32 mDbFlags;
  u64 flags;
  i64 lastRowid, szMmap;
  u32 nSchemaLock;
  unsigned openFlags;
  int errCode, errByteOffset, errMask, iSysErrno;
  u32 dbOptFlags;
  u8 enc, autoCommit, temp_store, mallocFailed, bBenignMalloc, dfltLockMode;
  signed char nextAutovac;
  u8 suppressErr, vtabOnConflict, isTransactionSavepoint, mTrace, noSharedCache;
  u8 nSqlExec, eOpenState, nFpDigit;
  int nextPagesize;
  i64 nChange, nTotalChange;
  int aLimit[SQLITE_N_LIMIT];
} sqlite3;
_Static_assert(offsetof(sqlite3, mutex) == 24, "mutex source prefix");
_Static_assert(offsetof(sqlite3, errCode) == 80, "error source prefix");
_Static_assert(offsetof(sqlite3, mallocFailed) == 103, "OOM source prefix");
_Static_assert(offsetof(sqlite3, eOpenState) == 113, "state source prefix");
_Static_assert(offsetof(sqlite3, nChange) == 120, "changes source prefix");
_Static_assert(offsetof(sqlite3, aLimit) == 136, "limits source prefix");

static char trace[4096];
static size_t traceLength;
static sqlite3 *active;
static unsigned callbackMode;
struct mutex_methods { void (*enter)(sqlite3_mutex *); void (*leave)(sqlite3_mutex *); };
static volatile struct mutex_methods mutexMethods;

static void appendEvent(const char *name, unsigned value) {
  traceLength += (size_t)snprintf(trace + traceLength, sizeof(trace) - traceLength,
                                "%s:%u;", name, value);
}
static void enterCallback(sqlite3_mutex *mutex) {
  appendEvent("enter", mutex->identity);
  if (callbackMode & 1) {
    active->nChange += 7;
    active->nTotalChange += 11;
    active->errCode = 0x1234;
    active->errMask = 0xff;
    active->aLimit[2] += 3;
  }
  if (callbackMode & 2) active->mutex = 0;
}
static void leaveCallback(sqlite3_mutex *mutex) {
  appendEvent("leave", mutex->identity);
  active->nChange += 100;
  active->nTotalChange += 200;
  active->aLimit[2] ^= 0x55;
}
static __attribute__((always_inline)) inline void sqlite3_mutex_enter(sqlite3_mutex *mutex) {
  if (mutex) mutexMethods.enter(mutex);
}
static __attribute__((always_inline)) inline void sqlite3_mutex_leave(sqlite3_mutex *mutex) {
  if (mutex) mutexMethods.leave(mutex);
}
SQLITE_API void sqlite3_log(int code, const char *format, ...) {
  char message[512];
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  traceLength += (size_t)snprintf(trace + traceLength, sizeof(trace) - traceLength,
                                "log:%d:%s;", code, message);
}
SQLITE_PRIVATE int sqlite3ReportError(int code, int line, const char *kind) {
  sqlite3_log(code, "%s at line %d of [%.10s]", kind, line, "be8d059e9a");
  return code;
}
SQLITE_PRIVATE int sqlite3MisuseError(int line) {
  return sqlite3ReportError(SQLITE_MISUSE, line, "misuse");
}
SQLITE_PRIVATE int sqlite3SafetyCheckSickOrOk(sqlite3 *);

/* Exact ASCII identifier membership described by SQLite's CtypeMap & 0x46. */
static int oracleIdChar(unsigned char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || c == '_' || c == '$' || c >= 0x80;
}
#define IdChar(C) oracleIdChar((unsigned char)(C))
SQLITE_PRIVATE int sqlite3StrNICmp(const char *a, const char *b, int n) {
  for (int i = 0; i < n; i++) {
    unsigned char x = (unsigned char)a[i], y = (unsigned char)b[i];
    if (x >= 'A' && x <= 'Z') x += 'a' - 'A';
    if (y >= 'A' && y <= 'Z') y += 'a' - 'A';
    if (x != y || x == 0) return (int)x - (int)y;
  }
  return 0;
}
/* The actual configured hard-limit vector is an oracle input. */
static int aHardLimit[SQLITE_N_LIMIT] = {
  1000000000, 1000000000, 2000, 1000, 500, 250000000, 1000, 10,
  50000, 32766, 1000, 8, 2500, 10000000, 65000
};
#line 38712 "sqlite3.c"
static void logBadConnection(const char *zType){
  sqlite3_log(SQLITE_MISUSE,
     "API call with %s database connection pointer",
     zType
  );
}

#line 38733 "sqlite3.c"
SQLITE_PRIVATE int sqlite3SafetyCheckOk(sqlite3 *db){
  u8 eOpenState;
  if( db==0 ){
    logBadConnection("NULL");
    return 0;
  }
  eOpenState = db->eOpenState;
  if( eOpenState!=SQLITE_STATE_OPEN ){
    if( sqlite3SafetyCheckSickOrOk(db) ){
      testcase( sqlite3GlobalConfig.xLog!=0 );
      logBadConnection("unopened");
    }
    return 0;
  }else{
    return 1;
  }
}
SQLITE_PRIVATE int sqlite3SafetyCheckSickOrOk(sqlite3 *db){
  u8 eOpenState;
  eOpenState = db->eOpenState;
  if( eOpenState!=SQLITE_STATE_SICK &&
      eOpenState!=SQLITE_STATE_OPEN &&
      eOpenState!=SQLITE_STATE_BUSY ){
    testcase( sqlite3GlobalConfig.xLog!=0 );
    logBadConnection("invalid");
    return 0;
  }else{
    return 1;
  }
}

#line 187960 "sqlite3.c"
SQLITE_API sqlite3_int64 sqlite3_incomplete(const char *zSql){
  u8 state = 0;   /* Current state, using numbers defined in header comment */
  u8 token;       /* Value of the next token */
  u8 pending = 0; /* unmatched structure character */
  int nParen = 0; /* Nested parentheses */

#ifndef SQLITE_OMIT_TRIGGER
  /* A complex statement machine used to detect the end of a CREATE TRIGGER
  ** statement.  This is the normal case.
  */
  static const u8 trans[8][8] = {
                     /* Token:                                                */
     /* State:       **  SEMI  WS  OTHER  EXPLAIN  CREATE  TEMP  TRIGGER  END */
     /* 0 NOTHING: */ {    1,  0,     2,       3,      4,    2,       2,   2, },
     /* 1   START: */ {    1,  1,     2,       3,      4,    2,       2,   2, },
     /* 2  NORMAL: */ {    1,  2,     2,       2,      2,    2,       2,   2, },
     /* 3 EXPLAIN: */ {    1,  3,     3,       2,      4,    2,       2,   2, },
     /* 4  CREATE: */ {    1,  4,     2,       2,      2,    4,       5,   2, },
     /* 5 TRIGGER: */ {    6,  5,     5,       5,      5,    5,       5,   5, },
     /* 6    SEMI: */ {    6,  6,     5,       5,      5,    5,       5,   7, },
     /* 7     END: */ {    1,  7,     5,       5,      5,    5,       5,   5, },
  };
#else
  /* If triggers are not supported by this compile then the statement machine
  ** used to detect the end of a statement is much simpler
  */
  static const u8 trans[3][3] = {
                     /* Token:           */
     /* State:       **  SEMI  WS  OTHER */
     /* 0 NOTHING: */ {    1,  0,     2, },
     /* 1   START: */ {    1,  1,     2, },
     /* 2  NORMAL: */ {    1,  2,     2, },
  };
#endif /* SQLITE_OMIT_TRIGGER */
  /* Mapping state number to yy value for the return */
  static const u8 statemap[8] = {
     /* 0 NOTHING */ 0,
     /* 1 START   */ 0,
     /* 2 NORMAL  */ 1,
     /* 3 EXPLAIN */ 1,
     /* 4 CREATE  */ 1,
     /* 5 TRIGGER */ 3,
     /* 6 SEMI    */ 2,
     /* 7 END     */ 1,
  };

#ifdef SQLITE_ENABLE_API_ARMOR
  if( zSql==0 ){
    return SQLITE_MISUSE_BKPT;
  }
#endif

  while( *zSql ){
    switch( *zSql ){
      case ';': {  /* A semicolon */
        token = tkSEMI;
        break;
      }
      case ' ':
      case '\r':
      case '\t':
      case '\n':
      case '\f': {  /* White space is ignored */
        token = tkWS;
        break;
      }
      case '/': {   /* C-style comments */
        if( zSql[1]!='*' ){
          token = tkOTHER;
          break;
        }
        zSql += 2;
        while( zSql[0] && (zSql[0]!='*' || zSql[1]!='/') ){ zSql++; }
        if( zSql[0]==0 ){
          pending = '/';
          goto incomplete_finish;
        }
        zSql++;
        token = tkWS;
        break;
      }
      case '-': {   /* SQL-style comments from "--" to end of line */
        if( zSql[1]!='-' ){
          token = tkOTHER;
          break;
        }
        while( *zSql && *zSql!='\n' ){ zSql++; }
        if( *zSql==0 ){
          pending = '-';
          goto incomplete_finish;
        }
        token = tkWS;
        break;
      }
      case '[': {   /* Microsoft-style identifiers in [...] */
        zSql++;
        while( *zSql && *zSql!=']' ){ zSql++; }
        if( *zSql==0 ){
          pending = ']';
          goto incomplete_finish;
        }
        token = tkOTHER;
        break;
      }
      case '`':     /* Grave-accent quoted symbols used by MySQL */
      case '"':     /* single- and double-quoted strings */
      case '\'': {
        int c = *zSql;
        zSql++;
        while( *zSql && *zSql!=c ){ zSql++; }
        if( *zSql==0 ){
          pending = c;
          goto incomplete_finish;
        }
        token = tkOTHER;
        break;
      }
      case '(': {
        nParen++;
        token = tkOTHER;
        break;
      }
      case ')': {
        nParen--;
        token = tkOTHER;
        break;
      }
      default: {
#ifdef SQLITE_EBCDIC
        unsigned char c;
#endif
        if( IdChar((u8)*zSql) ){
          /* Keywords and unquoted identifiers */
          int nId;
          for(nId=1; IdChar(zSql[nId]); nId++){}
#ifdef SQLITE_OMIT_TRIGGER
          token = tkOTHER;
#else
          switch( *zSql ){
            case 'c': case 'C': {
              if( nId==6 && sqlite3StrNICmp(zSql, "create", 6)==0 ){
                token = tkCREATE;
              }else{
                token = tkOTHER;
              }
              break;
            }
            case 't': case 'T': {
              if( nId==7 && sqlite3StrNICmp(zSql, "trigger", 7)==0 ){
                token = tkTRIGGER;
              }else if( nId==4 && sqlite3StrNICmp(zSql, "temp", 4)==0 ){
                token = tkTEMP;
              }else if( nId==9 && sqlite3StrNICmp(zSql, "temporary", 9)==0 ){
                token = tkTEMP;
              }else{
                token = tkOTHER;
              }
              break;
            }
            case 'e':  case 'E': {
              if( nId==3 && sqlite3StrNICmp(zSql, "end", 3)==0 ){
                token = tkEND;
              }else
#ifndef SQLITE_OMIT_EXPLAIN
              if( nId==7 && sqlite3StrNICmp(zSql, "explain", 7)==0 ){
                token = tkEXPLAIN;
              }else
#endif
              {
                token = tkOTHER;
              }
              break;
            }
            default: {
              token = tkOTHER;
              break;
            }
          }
#endif /* SQLITE_OMIT_TRIGGER */
          zSql += nId-1;
        }else{
          /* Operators and special symbols */
          token = tkOTHER;
        }
        break;
      }
    }
    state = trans[state][token];
    zSql++;
  }
incomplete_finish:
  if( state==0 && pending==0 ) return SQLITE_EMPTY;
  if( state==1 ) nParen = 0;
  return (i64)((((u64)nParen)<<32) |
               ((u64)pending<<16) |
               ((u64)statemap[state]<<8) |
               (state>1 || pending!=0));
}
SQLITE_API int sqlite3_complete(const char *zSql){
  return sqlite3_incomplete(zSql)==0;
}

#line 189452 "sqlite3.c"
SQLITE_API sqlite3_int64 sqlite3_changes64(sqlite3 *db){
  i64 iRet;
#ifdef SQLITE_ENABLE_API_ARMOR
  if( !sqlite3SafetyCheckOk(db) ){
    (void)SQLITE_MISUSE_BKPT;
    return 0;
  }
#endif
  sqlite3_mutex_enter(db->mutex);
  iRet = db->nChange;
  sqlite3_mutex_leave(db->mutex);
  return iRet;
}

#line 189472 "sqlite3.c"
SQLITE_API sqlite3_int64 sqlite3_total_changes64(sqlite3 *db){
  i64 iRet;
#ifdef SQLITE_ENABLE_API_ARMOR
  if( !sqlite3SafetyCheckOk(db) ){
    (void)SQLITE_MISUSE_BKPT;
    return 0;
  }
#endif
  sqlite3_mutex_enter(db->mutex);
  iRet = db->nTotalChange;
  sqlite3_mutex_leave(db->mutex);
  return iRet;
}

#line 191140 "sqlite3.c"
SQLITE_API int sqlite3_errcode(sqlite3 *db){
  int iRet;
  if( !db ) return SQLITE_NOMEM_BKPT;
  if( !sqlite3SafetyCheckSickOrOk(db) ){
    return SQLITE_MISUSE_BKPT;
  }
  sqlite3_mutex_enter(db->mutex);
  if( db->mallocFailed ){
    iRet = SQLITE_NOMEM_BKPT;
  }else{
    iRet = db->errCode & db->errMask;
  }
  sqlite3_mutex_leave(db->mutex);
  return iRet;
}

#line 191342 "sqlite3.c"
SQLITE_API int sqlite3_limit(sqlite3 *db, int limitId, int newLimit){
  int oldLimit;

#ifdef SQLITE_ENABLE_API_ARMOR
  if( !sqlite3SafetyCheckOk(db) ){
    (void)SQLITE_MISUSE_BKPT;
    return -1;
  }
#endif

  /* EVIDENCE-OF: R-30189-54097 For each limit category SQLITE_LIMIT_NAME
  ** there is a hard upper bound set at compile-time by a C preprocessor
  ** macro called SQLITE_MAX_NAME. (The "_LIMIT_" in the name is changed to
  ** "_MAX_".)
  */
  assert( aHardLimit[SQLITE_LIMIT_LENGTH]==SQLITE_MAX_LENGTH );
  assert( aHardLimit[SQLITE_LIMIT_SQL_LENGTH]==SQLITE_MAX_SQL_LENGTH );
  assert( aHardLimit[SQLITE_LIMIT_COLUMN]==SQLITE_MAX_COLUMN );
  assert( aHardLimit[SQLITE_LIMIT_EXPR_DEPTH]==SQLITE_MAX_EXPR_DEPTH );
  assert( aHardLimit[SQLITE_LIMIT_PARSER_DEPTH]==SQLITE_MAX_PARSER_DEPTH );
  assert( aHardLimit[SQLITE_LIMIT_COMPOUND_SELECT]==SQLITE_MAX_COMPOUND_SELECT);
  assert( aHardLimit[SQLITE_LIMIT_VDBE_OP]==SQLITE_MAX_VDBE_OP );
  assert( aHardLimit[SQLITE_LIMIT_FUNCTION_ARG]==SQLITE_MAX_FUNCTION_ARG );
  assert( aHardLimit[SQLITE_LIMIT_ATTACHED]==SQLITE_MAX_ATTACHED );
  assert( aHardLimit[SQLITE_LIMIT_LIKE_PATTERN_LENGTH]==
                                               SQLITE_MAX_LIKE_PATTERN_LENGTH );
  assert( aHardLimit[SQLITE_LIMIT_VARIABLE_NUMBER]==SQLITE_MAX_VARIABLE_NUMBER);
  assert( aHardLimit[SQLITE_LIMIT_TRIGGER_DEPTH]==SQLITE_MAX_TRIGGER_DEPTH );
  assert( aHardLimit[SQLITE_LIMIT_WORKER_THREADS]==SQLITE_MAX_WORKER_THREADS );
  assert( aHardLimit[SQLITE_LIMIT_SCHEMA]==SQLITE_MAX_SCHEMA );
  assert( aHardLimit[SQLITE_LIMIT_TRIGGER_STEPS]==SQLITE_MAX_TRIGGER_STEPS );
  assert( SQLITE_LIMIT_TRIGGER_STEPS==(SQLITE_N_LIMIT-1) );


  if( limitId<0 || limitId>=SQLITE_N_LIMIT ){
    return -1;
  }
  sqlite3_mutex_enter(db->mutex);
  oldLimit = db->aLimit[limitId];
  if( newLimit>=0 ){                   /* IMP: R-52476-28732 */
    if( newLimit>aHardLimit[limitId] ){
      newLimit = aHardLimit[limitId];  /* IMP: R-51463-25634 */
    }else if( newLimit<SQLITE_MIN_LENGTH && limitId==SQLITE_LIMIT_LENGTH ){
      newLimit = SQLITE_MIN_LENGTH;
    }
    db->aLimit[limitId] = newLimit;
  }
  sqlite3_mutex_leave(db->mutex);
  return oldLimit;                     /* IMP: R-53341-35419 */
}

#line 1 "sqlite-interfaces-oracle-main.c"
SQLITE_API u32 fixture_stack(u32 a) {
  volatile u32 local[3] = {a, 7, 9};
  return local[0] + local[1];
}
SQLITE_API u32 fixture_arithmetic(u32 a, u32 b) { return (a + b * 3u) ^ 0x55u; }
SQLITE_API u32 fixture_direct(u32 a) { return fixture_stack(a) + fixture_arithmetic(a, 2); }

static void reset(sqlite3 *db, sqlite3_mutex *mutex, unsigned state, unsigned mode) {
  memset(db, 0, sizeof(*db));
  db->eOpenState = (u8)state;
  db->mutex = mutex;
  db->nChange = INT64_C(0x123456789abcdef);
  db->nTotalChange = INT64_C(0x7f123456789abcde);
  db->errCode = (int)UINT32_C(0x81234567);
  db->errMask = 0xffff;
  for (unsigned i = 0; i < SQLITE_N_LIMIT; i++) db->aLimit[i] = 40 + (int)i;
  active = db;
  callbackMode = mode;
  traceLength = 0;
  trace[0] = 0;
}
static void report(const char *name, unsigned index, u64 result, const sqlite3 *db) {
  printf("%s %u %016" PRIx64 " %016" PRIx64 " %016" PRIx64 " %08x %08x %u %u",
         name, index, result, (u64)db->nChange, (u64)db->nTotalChange,
         (u32)db->errCode, (u32)db->errMask, db->mallocFailed, db->mutex != 0);
  for (unsigned i = 0; i < SQLITE_N_LIMIT; i++) printf(" %d", db->aLimit[i]);
  printf(" ");
  if (!traceLength) printf("-");
  for (size_t i = 0; i < traceLength; i++) printf("%02x", (unsigned char)trace[i]);
  printf("\n");
}
int main(int argc, char **argv) {
  if (argc != 1 && argc != SQLITE_N_LIMIT + 1) return 2;
  if (argc == SQLITE_N_LIMIT + 1)
    for (unsigned i = 0; i < SQLITE_N_LIMIT; i++) aHardLimit[i] = (int)strtol(argv[i + 1], 0, 10);
  mutexMethods.enter = enterCallback;
  mutexMethods.leave = leaveCallback;
  sqlite3 db;
  sqlite3_mutex mutex = {17};
  for (unsigned which = 0; which < 2; which++)
    for (unsigned i = 0; i < 6; i++) {
      const unsigned state = i == 4 ? SQLITE_STATE_SICK : i == 5 ? 0xce : SQLITE_STATE_OPEN;
      reset(&db, i == 2 || i == 3 ? &mutex : 0, state, i == 2 ? 1 : i == 3 ? 3 : 0);
      const i64 result = which ? sqlite3_total_changes64(i == 0 ? 0 : &db)
                               : sqlite3_changes64(i == 0 ? 0 : &db);
      report(which ? "total" : "changes", i, (u64)result, &db);
    }
  for (unsigned i = 0; i < 6; i++) {
    const unsigned state = i == 4 ? SQLITE_STATE_SICK : i == 5 ? 0xce : SQLITE_STATE_OPEN;
    reset(&db, i == 2 || i == 3 ? &mutex : 0, state, i == 2 ? 1 : 0);
    db.mallocFailed = i == 3;
    report("errcode", i, (u64)(u32)sqlite3_errcode(i == 0 ? 0 : &db), &db);
  }
  const int ids[] = {0, -1, 15, 2, 2, 0, 0, 2, 2};
  const int limits[] = {1, 7, 7, -1, 1000000000, 0, 1000000001, 17, 17};
  for (unsigned i = 0; i < sizeof(ids) / sizeof(ids[0]); i++) {
    reset(&db, i == 7 ? &mutex : 0, i == 8 ? 0xce : SQLITE_STATE_OPEN, i == 7 ? 1 : 0);
    report("limit", i, (u64)(u32)sqlite3_limit(i == 0 ? 0 : &db, ids[i], limits[i]), &db);
  }
  const char *sql[] = {
    0, "", "   \t", ";", "SELECT 1;", "SELECT 1", "SELECT (", "SELECT ((",
    "SELECT )", "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;",
    "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END", "'unterminated",
    "/* comment", "[identifier", "-- comment", "SELECT '\xc3\xa9';"
  };
  for (unsigned i = 0; i < sizeof(sql) / sizeof(sql[0]); i++) {
    reset(&db, 0, SQLITE_STATE_OPEN, 0);
    report("incomplete", i, (u64)sqlite3_incomplete(sql[i]), &db);
    reset(&db, 0, SQLITE_STATE_OPEN, 0);
    report("complete", i, (u64)(u32)sqlite3_complete(sql[i]), &db);
  }
  const u32 direct[] = {0, 1, UINT32_C(0x80000000), UINT32_MAX};
  for (unsigned i = 0; i < sizeof(direct) / sizeof(direct[0]); i++) {
    reset(&db, 0, SQLITE_STATE_OPEN, 0);
    report("direct", i, fixture_direct(direct[i]), &db);
  }
  return 0;
}
