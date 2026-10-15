export const ENCODINGS = [
    {
        "instructionId": "str_za_ri",
        "encodingId": "str_za_ri_",
        "mnemonic": "STR",
        "className": "SME",
        "fileName": "str_za_ri.xml",
        "mask": 4294941712,
        "value": 3776970752,
        "bitCount": 21,
        "fields": [
            {
                "name": "op",
                "lsb": 21,
                "width": 1
            },
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "off4",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-ldr-za-array-vector"
    }
];
