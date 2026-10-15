export const ENCODINGS = [
    {
        "instructionId": "str_zt_br",
        "encodingId": "str_zt_br_",
        "mnemonic": "STR",
        "className": "SME2",
        "fileName": "str_zt_br.xml",
        "mask": 4294966303,
        "value": 3779035136,
        "bitCount": 27,
        "fields": [
            {
                "name": "opc",
                "lsb": 16,
                "width": 6
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "opc2",
                "lsb": 0,
                "width": 2
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-zt-memory"
    }
];
