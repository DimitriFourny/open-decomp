export const ENCODINGS = [
    {
        "instructionId": "PSSBB_DSB",
        "encodingId": "PSSBB_DSB_BO_barriers",
        "mnemonic": "DSB",
        "className": "Memory barrier",
        "fileName": "pssbb_dsb.xml",
        "mask": 4294967295,
        "value": 3573757087,
        "bitCount": 32,
        "fields": [
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "canonicalEncodingId": "DSB_BO_barriers",
        "canonicalFileName": "dsb.xml",
        "operandFamilyId": "no-operands"
    }
];
