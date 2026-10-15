export const ENCODINGS = [
    {
        "instructionId": "bfcvtn_z_mz2",
        "encodingId": "bfcvtn_z_mz2_",
        "mnemonic": "BFCVTN",
        "className": "SME2",
        "fileName": "bfcvtn_z_mz2.xml",
        "mask": 4294966304,
        "value": 3244351520,
        "bitCount": 23,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "N",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
        "operandFamilyId": "sme-narrowing-convert"
    }
];
