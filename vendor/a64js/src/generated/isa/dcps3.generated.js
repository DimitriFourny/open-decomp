export const ENCODINGS = [
    {
        "instructionId": "DCPS3",
        "encodingId": "DCPS3_DC_exception",
        "mnemonic": "DCPS3",
        "className": "System",
        "fileName": "dcps3.xml",
        "mask": 4292870175,
        "value": 3567255555,
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
        "operandFamilyId": "exception-immediate"
    }
];
