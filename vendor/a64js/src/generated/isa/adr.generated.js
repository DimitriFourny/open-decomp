export const ENCODINGS = [
    {
        "instructionId": "ADR",
        "encodingId": "ADR_only_pcreladdr",
        "mnemonic": "ADR",
        "className": "Literal",
        "fileName": "adr.xml",
        "mask": 2667577344,
        "value": 268435456,
        "bitCount": 6,
        "fields": [
            {
                "name": "op",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "immlo",
                "lsb": 29,
                "width": 2
            },
            {
                "name": "immhi",
                "lsb": 5,
                "width": 19
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "adr"
    }
];
