export const ENCODINGS = [
    {
        "instructionId": "ADRP",
        "encodingId": "ADRP_only_pcreladdr",
        "mnemonic": "ADRP",
        "className": "Literal",
        "fileName": "adrp.xml",
        "mask": 2667577344,
        "value": 2415919104,
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
        "operandFamilyId": "adr-adrp"
    }
];
