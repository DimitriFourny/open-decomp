export const ENCODINGS = [
    {
        "instructionId": "HLT",
        "encodingId": "HLT_EX_exception",
        "mnemonic": "HLT",
        "className": "System",
        "fileName": "hlt.xml",
        "mask": 4292870175,
        "value": 3560964096,
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
            "HaltingAllowed(): debug halting permission is not configured; assumes the instruction is admitted by the implementation",
            "EDSCR().HDE == '0': EDSCR.HDE is not configured; assumes the instruction is admitted by the implementation"
        ],
        "operandFamilyId": "exception-immediate"
    }
];
