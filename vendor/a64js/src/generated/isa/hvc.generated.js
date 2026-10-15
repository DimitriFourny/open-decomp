export const ENCODINGS = [
    {
        "instructionId": "HVC",
        "encodingId": "HVC_EX_exception",
        "mnemonic": "HVC",
        "className": "System",
        "fileName": "hvc.xml",
        "mask": 4292870175,
        "value": 3556769794,
        "bitCount": 16,
        "fields": [
            {
                "name": "opc",
                "lsb": 21,
                "width": 3
            },
            {
                "name": "imm16",
                "lsb": 5,
                "width": 16
            },
            {
                "name": "op2",
                "lsb": 2,
                "width": 3
            },
            {
                "name": "LL",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "guardDiagnostics": [
            "HaveEL(EL2): EL2 implementation is not configured; assumes the instruction is admitted by the implementation"
        ],
        "operandFamilyId": "exception-immediate"
    }
];
