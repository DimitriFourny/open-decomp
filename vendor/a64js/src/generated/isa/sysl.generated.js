export const ENCODINGS = [
    {
        "instructionId": "SYSL",
        "encodingId": "SYSL_RC_systeminstrs",
        "mnemonic": "SYSL",
        "className": "System",
        "fileName": "sysl.xml",
        "mask": 4294443008,
        "value": 3576168448,
        "bitCount": 13,
        "fields": [
            {
                "name": "L",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "op1",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "CRn",
                "lsb": 12,
                "width": 4
            },
            {
                "name": "CRm",
                "lsb": 8,
                "width": 4
            },
            {
                "name": "op2",
                "lsb": 5,
                "width": 3
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
        "operandFamilyId": "sysl"
    }
];
