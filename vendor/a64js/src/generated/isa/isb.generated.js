export const ENCODINGS = [
    {
        "instructionId": "ISB",
        "encodingId": "ISB_BI_barriers",
        "mnemonic": "ISB",
        "className": "System",
        "fileName": "isb.xml",
        "mask": 4294963455,
        "value": 3573756127,
        "bitCount": 28,
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
        "operandFamilyId": "isb"
    }
];
